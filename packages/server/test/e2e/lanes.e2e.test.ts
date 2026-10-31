import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApprovalInfoResponse, GraphInput, NodeRun } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_GH } from "../helpers.js";
import { createWorld, E2eServer, readClaudeLog, until, type E2eWorld } from "./harness.js";

type Spec = { id: string; type: string; at: [number, number]; config?: Record<string, unknown> };

/** Graph from nodes at canvas positions [x, y] and edges "a>b". */
function graph(id: string, nodes: Spec[], edges: string[], settings: Record<string, unknown> = {}): GraphInput {
  return {
    version: 1,
    id,
    name: id,
    settings: { defaults: { completion: { mode: "auto", graceSec: 0 } }, ...settings },
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, label: n.id, position: { x: n.at[0], y: n.at[1] }, config: n.config ?? {} })),
    edges: edges.map((e, i) => {
      const [source, target] = e.split(">");
      return { id: `e${i}`, source: source!, target: target! };
    }),
  } as GraphInput;
}

const write = (file: string, content: string) => ({ prompt: `[[write:${file}:${content}]] Write ${file}` });

describe("e2e: parallel lanes and ship-it nodes (M3+M4)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  async function setup(extraEnv: Record<string, string> = {}): Promise<{ w: E2eWorld; s: E2eServer; origin: string; ghLog: string }> {
    const w = createWorld({ PG_GH_BIN: FAKE_GH, SHELL: "/bin/sh", ...extraEnv });
    cleanups.push(() => w.cleanup());
    const ghLog = path.join(w.root, "gh.log");
    w.env.FAKE_GH_LOG = ghLog;
    const origin = path.join(w.root, "origin.git");
    gitIn(w.root, "init", "-q", "--bare", origin);
    gitIn(w.repo, "remote", "add", "origin", origin);
    const s = await E2eServer.start(w);
    cleanups.push(() => s.close());
    return { w, s, origin, ghLog };
  }

  it("fan-out → merge → commit → approval → pr, then cleanup keeps the pushed branch", { timeout: 90_000 }, async () => {
    const { w, s, origin, ghLog } = await setup();
    await s.saveGraph(
      graph(
        "fan",
        [
          { id: "root", type: "prompt", at: [0, 100], config: write("a.txt", "A") },
          { id: "b", type: "prompt", at: [250, 0], config: write("b.txt", "B") },
          { id: "c", type: "prompt", at: [250, 200], config: write("c.txt", "C") },
          { id: "m", type: "merge", at: [500, 100] },
          { id: "commit", type: "commit", at: [750, 100] },
          { id: "gate", type: "approval", at: [1000, 100], config: { message: "Ship it?" } },
          { id: "pr", type: "pr", at: [1250, 100], config: { requireApproval: false } },
        ],
        ["root>b", "root>c", "b>m", "c>m", "m>commit", "commit>gate", "gate>pr"],
        { allowPrWithoutApproval: true },
      ),
    );
    const runId = (await s.startRun("fan")).run.id;

    const gate = await s.waitForNode(runId, "gate", ["waiting_approval"], 30_000);
    let detail = await s.getRun(runId);
    const [main, fork] = detail.lanes;
    expect(detail.lanes.map((l) => l.id)).toEqual(["main", "l2"]);
    const laneOf = (nodeId: string) => detail.nodeRuns.find((n) => n.nodeId === nodeId)!.laneId;
    expect(["root", "b", "m", "commit", "gate"].map(laneOf)).toEqual(Array(5).fill("main"));
    expect(laneOf("c")).toBe("l2");
    // Separate worktrees and branches, both still present while the gate waits.
    expect(main!.worktreePath).not.toBe(fork!.worktreePath);
    for (const lane of [main!, fork!]) {
      expect(fs.existsSync(lane.worktreePath)).toBe(true);
      expect(gitIn(w.repo, "branch", "--list", lane.branch)).toContain(lane.branch);
    }
    // The fork lane holds the checkpoints (fork point, merge preparation) ...
    expect(gitIn(w.repo, "log", "--format=%s", `main..${fork!.branch}`).split("\n")).toEqual([
      "pg: checkpoint after c",
      "pg: checkpoint after root",
    ]);
    expect(fork!.baseRef).toBe(gitIn(w.repo, "rev-parse", `${fork!.branch}~1`));
    // ... and the commit node squashed checkpoints and the lane merge into one commit with all three files.
    const commitRun = detail.nodeRuns.find((n) => n.nodeId === "commit")!;
    const message = commitRun.output!.message as string;
    expect(gitIn(w.repo, "log", "--format=%s", `main..${main!.branch}`)).toBe(message.split("\n")[0]);
    expect(gitIn(w.repo, "rev-parse", main!.branch)).toBe(commitRun.output!.sha);
    expect(gitIn(w.repo, "ls-tree", "--name-only", main!.branch).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt", "c.txt"]);
    expect(detail.nodeRuns.find((n) => n.nodeId === "m")!.output).toMatchObject({ conflictedFiles: [] });

    const info = await s.api<ApprovalInfoResponse>("GET", `/api/node-runs/${gate.id}/approval`);
    expect(info.predecessorOutputs).toEqual([{ nodeId: "commit", label: "commit", text: `Commit ${commitRun.output!.sha!.slice(0, 8)}: ${message}` }]);

    // The gate holds the run until the approval is posted.
    await new Promise((r) => setTimeout(r, 300));
    detail = await s.getRun(runId);
    expect(detail.run.status).toBe("running");
    expect(detail.nodeRuns.find((n) => n.nodeId === "pr")!.status).toBe("pending");
    expect(fs.existsSync(ghLog)).toBe(false);
    await s.api("POST", `/api/node-runs/${gate.id}/approval`, { approved: true });

    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    expect(done.nodeRuns.find((n) => n.nodeId === "pr")!.output).toMatchObject({
      prUrl: "https://github.com/fake/repo/pull/1",
      title: "fake title",
      body: "fake body",
    });
    expect(gitIn(origin, "rev-parse", main!.branch)).toBe(commitRun.output!.sha);
    const calls = fs.readFileSync(ghLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(["pr", "create", "--base", "main", "--head", main!.branch, "--title", "fake title", "--body-file", "-", "--draft"]);
    expect(calls[0]!.cwd).toBe(main!.worktreePath);
    expect(calls[0]!.stdin).toBe("fake body");

    // keepWorktrees on-failure + success: worktrees removed, merged fork branch deleted, pushed branch kept.
    const cleaned = await until(async () => {
      const d = await s.getRun(runId);
      return d.run.cleanedUp && d;
    });
    expect(cleaned.lanes.map((l) => [l.id, l.status, l.pushed])).toEqual([
      ["main", "removed", true],
      ["l2", "removed", false],
    ]);
    expect(fs.existsSync(main!.worktreePath)).toBe(false);
    expect(fs.existsSync(fork!.worktreePath)).toBe(false);
    expect(gitIn(w.repo, "branch", "--list", main!.branch)).toContain(main!.branch);
    expect(gitIn(w.repo, "branch", "--list", fork!.branch)).toBe("");
  });

  const conflictGraph = (id: string, onConflict: "claude" | "pause") =>
    graph(
      id,
      [
        { id: "a", type: "prompt", at: [0, 0], config: write("README.md", "from a") },
        { id: "b", type: "prompt", at: [0, 200], config: write("README.md", "from b") },
        { id: "m", type: "merge", at: [300, 100], config: { onConflict } },
      ],
      ["a>m", "b>m"],
      { keepWorktrees: "always" },
    );

  it("merge conflict with onConflict claude: the resolver writes and stages the file", { timeout: 60_000 }, async () => {
    // Only the resolver runs inside a merge in progress; the prompt nodes skip the bash marker.
    const resolve = "if test -f \"$(git rev-parse --git-path MERGE_HEAD)\"; then printf 'resolved by claude' > README.md && git add README.md; fi";
    const { w, s } = await setup({ FAKE_CLAUDE_MODE: `[[bash:${resolve}]]` });
    await s.saveGraph(conflictGraph("conflict-claude", "claude"));
    const runId = (await s.startRun("conflict-claude")).run.id;
    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 45_000);
    expect(done.run.status).toBe("succeeded");
    const merge = done.nodeRuns.find((n) => n.nodeId === "m")!;
    expect(merge.output).toMatchObject({ conflictedFiles: ["README.md"] });
    const main = done.lanes.find((l) => l.id === "main")!;
    expect(gitIn(w.repo, "show", `${main.branch}:README.md`)).toBe("resolved by claude");
    expect(gitIn(w.repo, "log", "-1", "--format=%s", main.branch)).toBe(`Merge branch '${done.lanes[1]!.branch}' into ${main.branch}`);
    const resolver = readClaudeLog(w).filter((c) => c.cwd === main.worktreePath && c.argv.some((a) => a.includes("merge conflict")));
    expect(resolver).toHaveLength(1);
  });

  it("merge conflict with onConflict pause: resolved through the shell PTY, then Done", { timeout: 60_000 }, async () => {
    const { w, s } = await setup();
    await s.saveGraph(conflictGraph("conflict-pause", "pause"));
    const runId = (await s.startRun("conflict-pause")).run.id;
    const merge = await s.waitForNode(runId, "m", ["waiting_input", "failed"], 30_000);
    expect(merge).toMatchObject({ status: "waiting_input", ptyId: `shell-${merge.id}`, waitingReason: { kind: "merge_conflict" } });

    const ws = await s.connectWs();
    cleanups.push(() => ws.close());
    ws.attach(merge.ptyId!);
    ws.input(merge.ptyId!, "printf 'resolved by hand' > README.md && git add README.md && echo RESOLVED-OK\r");
    await until(async () => ws.ptyText(merge.ptyId!).includes("RESOLVED-OK"));
    await s.api("POST", `/api/node-runs/${merge.id}/done`);

    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    const main = done.lanes.find((l) => l.id === "main")!;
    expect(gitIn(w.repo, "show", `${main.branch}:README.md`)).toBe("resolved by hand");
    expect(gitIn(w.repo, "rev-list", "--parents", "-1", main.branch).split(" ")).toHaveLength(3);
  });

  it("a merge left mid-conflict by a stopped server is redone cleanly on Retry", { timeout: 90_000 }, async () => {
    const { w, s } = await setup();
    await s.saveGraph(conflictGraph("conflict-crash", "pause"));
    const runId = (await s.startRun("conflict-crash")).run.id;
    await s.waitForNode(runId, "m", ["waiting_input"], 30_000);
    const [main, l2] = (await s.getRun(runId)).lanes;
    await s.close();
    // A crash (unlike this graceful stop) leaves the lane mid-merge, conflict markers and all.
    expect(() => gitIn(main!.worktreePath, "merge", "--no-ff", "-m", "x", l2!.branch)).toThrow();
    const before = gitIn(main!.worktreePath, "rev-parse", "HEAD");

    const s2 = await E2eServer.start(w);
    cleanups.push(() => s2.close());
    const interrupted = await s2.nodeRun(runId, "m");
    expect(interrupted.status).toBe("interrupted");
    await s2.api("POST", `/api/node-runs/${interrupted.id}/retry`);
    const retried = await s2.waitForNode(runId, "m", ["waiting_input", "failed", "succeeded"], 30_000);
    expect(retried).toMatchObject({ status: "waiting_input", attempt: 1, waitingReason: { kind: "merge_conflict" } });
    // The half-done merge was dropped, not checkpointed: HEAD is unchanged and the merge is fresh.
    expect(gitIn(main!.worktreePath, "rev-parse", "HEAD")).toBe(before);
    fs.writeFileSync(path.join(main!.worktreePath, "README.md"), "from both\n");
    await s2.api("POST", `/api/node-runs/${retried.id}/done`);
    const done = await s2.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    expect(gitIn(w.repo, "show", `${main!.branch}:README.md`)).toBe("from both");
    expect(gitIn(w.repo, "log", "--format=%s", `main..${main!.branch}`)).not.toContain("checkpoint after m");
    expect(gitIn(w.repo, "rev-list", "--parents", "-1", main!.branch).split(" ")).toHaveLength(3);
  });

  it("skipping a merge left mid-conflict by a stopped server drops the half-done merge; the next commit has no markers", { timeout: 90_000 }, async () => {
    const { w, s } = await setup();
    const g = conflictGraph("conflict-skip", "pause");
    await s.saveGraph({
      ...g,
      nodes: [...(g.nodes ?? []), { id: "c", type: "commit", label: "c", position: { x: 600, y: 100 }, config: {} }],
      edges: [...(g.edges ?? []), { id: "e-mc", source: "m", target: "c" }],
    } as GraphInput);
    const runId = (await s.startRun("conflict-skip")).run.id;
    await s.waitForNode(runId, "m", ["waiting_input"], 30_000);
    const [main, l2] = (await s.getRun(runId)).lanes;
    await s.close();
    expect(() => gitIn(main!.worktreePath, "merge", "--no-ff", "-m", "x", l2!.branch)).toThrow();

    const s2 = await E2eServer.start(w);
    cleanups.push(() => s2.close());
    const interrupted = await s2.nodeRun(runId, "m");
    expect(interrupted.status).toBe("interrupted");
    await s2.api("POST", `/api/node-runs/${interrupted.id}/skip`);
    const done = await s2.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    // No merge in progress, README unchanged from lane a, and nothing with conflict markers was committed.
    expect(() => gitIn(main!.worktreePath, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(gitIn(w.repo, "show", `${main!.branch}:README.md`)).not.toContain("<<<<<<<");
    // The commit (checkpoints squashed into it) is a plain one-parent commit with lane a's README.
    expect(gitIn(w.repo, "show", `${main!.branch}:README.md`)).toBe("from a");
    expect(gitIn(w.repo, "rev-list", "--parents", "-1", main!.branch).split(" ")).toHaveLength(2);
  });

  it("merge with strategy squash, then commit: one generated commit, no checkpoint noise", { timeout: 60_000 }, async () => {
    const { w, s } = await setup();
    await s.saveGraph(
      graph(
        "squash-commit",
        [
          { id: "root", type: "prompt", at: [0, 100], config: write("a.txt", "A") },
          { id: "b", type: "prompt", at: [250, 0], config: write("b.txt", "B") },
          { id: "c", type: "prompt", at: [250, 200], config: write("c.txt", "C") },
          { id: "m", type: "merge", at: [500, 100], config: { strategy: "squash" } },
          { id: "commit", type: "commit", at: [750, 100] },
        ],
        ["root>b", "root>c", "b>m", "c>m", "m>commit"],
        { keepWorktrees: "always" },
      ),
    );
    const runId = (await s.startRun("squash-commit")).run.id;
    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    const commit = done.nodeRuns.find((n) => n.nodeId === "commit")!;
    expect(commit.output?.noop).toBeUndefined();
    const main = done.lanes.find((l) => l.id === "main")!;
    expect(gitIn(w.repo, "log", "--format=%s", `main..${main.branch}`)).toBe((commit.output!.message as string).split("\n")[0]);
    expect(gitIn(w.repo, "ls-tree", "--name-only", main.branch).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt", "c.txt"]);
  });

  const slowRoots = (id: string, maxParallelClaude: number) =>
    graph(
      id,
      ["x", "y", "z"].map((n, i) => ({ id: n, type: "prompt", at: [0, i * 200] as [number, number], config: { prompt: `[[sleep:400]] ${n}` } })),
      [],
      { maxParallelClaude },
    );
  const overlaps = (runs: NodeRun[]) => {
    const sorted = [...runs].sort((a, b) => a.startedAt! - b.startedAt!);
    return sorted.slice(1).some((r, i) => r.startedAt! < sorted[i]!.finishedAt!);
  };

  it("maxParallelClaude 1 serializes Claude nodes across lanes", { timeout: 60_000 }, async () => {
    const { s } = await setup();
    await s.saveGraph(slowRoots("serial", 1));
    await s.saveGraph(slowRoots("parallel", 3));
    const timings = (runs: NodeRun[]) => JSON.stringify(runs.map((r) => [r.nodeId, r.status, r.error, r.startedAt, r.finishedAt]));
    const serial = await s.waitForRun((await s.startRun("serial")).run.id, ["succeeded", "failed", "paused"], 30_000);
    expect(serial.run.status, timings(serial.nodeRuns)).toBe("succeeded");
    expect(new Set(serial.nodeRuns.map((n) => n.laneId)).size).toBe(3);
    expect(overlaps(serial.nodeRuns), timings(serial.nodeRuns)).toBe(false);
    const parallel = await s.waitForRun((await s.startRun("parallel")).run.id, ["succeeded", "failed", "paused"], 30_000);
    expect(parallel.run.status, timings(parallel.nodeRuns)).toBe("succeeded");
    expect(overlaps(parallel.nodeRuns), timings(parallel.nodeRuns)).toBe(true);
  });

  it("a rejected approval in one lane fails the node and pauses the run; the other lane finishes", { timeout: 60_000 }, async () => {
    const { s } = await setup();
    await s.saveGraph(
      graph(
        "reject",
        [
          { id: "root", type: "prompt", at: [0, 100], config: write("a.txt", "A") },
          { id: "gate", type: "approval", at: [250, 0] },
          { id: "after", type: "shell", at: [500, 0], config: { run: "true" } },
          { id: "side", type: "shell", at: [250, 200], config: { run: "echo side > side.txt" } },
        ],
        ["root>gate", "gate>after", "root>side"],
      ),
    );
    const runId = (await s.startRun("reject")).run.id;
    const gate = await s.waitForNode(runId, "gate", ["waiting_approval"], 30_000);
    await s.api("POST", `/api/node-runs/${gate.id}/approval`, { approved: false, comment: "not yet" });
    const done = await s.waitForRun(runId, ["paused", "failed", "succeeded"], 30_000);
    expect(done.run.status).toBe("paused");
    const status = (id: string) => done.nodeRuns.find((n) => n.nodeId === id)!;
    expect(status("gate")).toMatchObject({ status: "failed", error: "Approval rejected: not yet" });
    expect(status("after").status).toBe("pending");
    expect(status("side")).toMatchObject({ status: "succeeded", laneId: "l2" });
  });

  it("a failing workspaceSetup fails the first node of the lane only", { timeout: 60_000 }, async () => {
    const { w, s } = await setup();
    // Fails in the fork lane's worktree (path ends with the lane id), succeeds in the root lane.
    await s.saveGraph(
      graph(
        "setup",
        [
          { id: "root", type: "shell", at: [0, 100], config: { run: "true" } },
          { id: "keep", type: "shell", at: [250, 0], config: { run: "true" } },
          { id: "forked", type: "shell", at: [250, 200], config: { run: "true" } },
        ],
        ["root>keep", "root>forked"],
        { workspaceSetup: "echo setting up >> setup.log; case \"$PWD\" in */l2) echo boom; exit 3;; esac" },
      ),
    );
    const runId = (await s.startRun("setup")).run.id;
    const done = await s.waitForRun(runId, ["paused", "failed", "succeeded"], 30_000);
    expect(done.run.status).toBe("paused");
    const nr = (id: string) => done.nodeRuns.find((n) => n.nodeId === id)!;
    expect(nr("root")).toMatchObject({ status: "succeeded", laneSetup: "succeeded" });
    expect(nr("keep")).toMatchObject({ status: "succeeded", laneSetup: null });
    expect(nr("forked")).toMatchObject({ status: "failed", laneSetup: "failed", error: "Workspace setup failed (exit code 3)" });
    expect(readClaudeLog(w)).toEqual([]);
  });

  it("a rejected pr fails the node without pushing or calling gh", { timeout: 60_000 }, async () => {
    const { s, origin, ghLog } = await setup();
    await s.saveGraph(
      graph(
        "pr-reject",
        [
          { id: "work", type: "prompt", at: [0, 0], config: write("notes.txt", "n") },
          { id: "pr", type: "pr", at: [250, 0], config: { title: "Notes", body: "Adds notes." } },
        ],
        ["work>pr"],
      ),
    );
    const runId = (await s.startRun("pr-reject")).run.id;
    const pr = await s.waitForNode(runId, "pr", ["waiting_approval"], 30_000);
    await s.api("POST", `/api/node-runs/${pr.id}/approval`, { approved: false, comment: "wrong base" });
    const done = await s.waitForRun(runId, ["paused", "failed", "succeeded"], 30_000);
    expect(done.run.status).toBe("paused");
    expect(done.nodeRuns.find((n) => n.nodeId === "pr")).toMatchObject({ status: "failed", error: "Pull request rejected: wrong base" });
    expect(done.lanes[0]!.pushed).toBe(false);
    expect(gitIn(origin, "branch", "--list")).toBe("");
    expect(fs.existsSync(ghLog)).toBe(false);
  });
});
