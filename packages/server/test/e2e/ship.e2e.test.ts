import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApprovalInfoResponse, DiffResponse, NodeRunResponse, PendingResponse } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_GH } from "../helpers.js";
import { chainGraph, createWorld, E2eServer } from "./harness.js";

describe("e2e: approval, pr and merge nodes", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("approval gate with diff, then a PR pushed to origin and created with gh", { timeout: 60_000 }, async () => {
    const w = createWorld({ PG_GH_BIN: FAKE_GH });
    cleanups.push(() => w.cleanup());
    const ghLog = path.join(w.root, "gh.log");
    w.env.FAKE_GH_LOG = ghLog;
    const origin = path.join(w.root, "origin.git");
    gitIn(w.root, "init", "-q", "--bare", origin);
    gitIn(w.repo, "remote", "add", "origin", origin);
    const s = await E2eServer.start(w);
    cleanups.push(() => s.close());

    await s.saveGraph(
      chainGraph("ship", [
        { id: "write", type: "prompt", config: { prompt: "[[write:notes.txt:shipped]] Write the notes" } },
        { id: "gate", type: "approval", config: { message: "Looks right?" } },
        { id: "pr", type: "pr", config: {} },
      ]),
    );
    const runId = (await s.startRun("ship")).run.id;

    const gate = await s.waitForNode(runId, "gate", ["waiting_approval"]);
    const pending = await s.api<PendingResponse>("GET", "/api/pending");
    expect(pending.nodeRuns.map((n) => n.id)).toEqual([gate.id]);
    expect((await s.getRun(runId)).run.pendingApprovals).toBe(1);
    const info = await s.api<ApprovalInfoResponse>("GET", `/api/node-runs/${gate.id}/approval`);
    expect(info).toMatchObject({ message: "Looks right?", showDiff: true, pr: null, predecessorOutputs: [{ nodeId: "write", text: "Done: Write the notes" }] });
    // Untracked work shows in the lane diff.
    const diff = await s.api<DiffResponse>("GET", `/api/node-runs/${gate.id}/diff`);
    expect(diff.files).toEqual([expect.objectContaining({ path: "notes.txt", status: "added", additions: 1 })]);
    expect(diff.patch).toContain("+shipped");

    const approved = await s.api<NodeRunResponse>("POST", `/api/node-runs/${gate.id}/approval`, { approved: true, comment: "go" });
    expect(approved.nodeRun.id).toBe(gate.id);

    const pr = await s.waitForNode(runId, "pr", ["waiting_approval"]);
    const prInfo = await s.api<ApprovalInfoResponse>("GET", `/api/node-runs/${pr.id}/approval`);
    expect(prInfo.pr).toEqual({ title: "fake title", body: "fake body", base: "main", draft: true });
    // The pr diff is what gets pushed: the checkpointed commit.
    const prDiff = await s.api<DiffResponse>("GET", `/api/node-runs/${pr.id}/diff`);
    expect(prDiff.files.map((f) => f.path)).toEqual(["notes.txt"]);
    const stale = await s.request("POST", `/api/node-runs/${pr.id}/approval`, { approved: true, headSha: prDiff.base });
    expect(stale.status).toBe(409);
    await s.api("POST", `/api/node-runs/${pr.id}/approval`, { approved: true, title: "Ship notes", body: "Adds notes.", headSha: prDiff.head });

    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    const prRun = done.nodeRuns.find((n) => n.nodeId === "pr")!;
    expect(prRun.output).toMatchObject({ prUrl: "https://github.com/fake/repo/pull/1", title: "Ship notes", body: "Adds notes.", approved: true });
    expect(done.nodeRuns.find((n) => n.nodeId === "gate")!.output).toEqual({ approved: true, comment: "go" });

    const lane = done.lanes[0]!;
    expect(lane.pushed).toBe(true);
    expect(gitIn(origin, "show", `${lane.branch}:notes.txt`)).toBe("shipped");
    expect(gitIn(origin, "rev-parse", lane.branch)).toBe(prDiff.head);
    const call = JSON.parse(fs.readFileSync(ghLog, "utf8").trim()) as { argv: string[]; stdin: string };
    expect(call.argv).toEqual(["pr", "create", "--base", "main", "--head", lane.branch, "--title", "Ship notes", "--body-file", "-", "--draft"]);
    expect(call.stdin).toBe("Adds notes.");
    // Cleanup keeps the pushed branch.
    await s.api("POST", `/api/runs/${runId}/cleanup`);
    expect(gitIn(w.repo, "branch", "--list", lane.branch)).toContain(lane.branch);
  });

  it("a rejected approval fails the node and pauses the run", { timeout: 40_000 }, async () => {
    const w = createWorld();
    cleanups.push(() => w.cleanup());
    const s = await E2eServer.start(w);
    cleanups.push(() => s.close());
    await s.saveGraph(chainGraph("gate", [{ id: "gate", type: "approval" }, { id: "after", type: "shell", config: { run: "true" } }]));
    const runId = (await s.startRun("gate")).run.id;
    const gate = await s.waitForNode(runId, "gate", ["waiting_approval"]);
    await s.api("POST", `/api/node-runs/${gate.id}/approval`, { approved: false, comment: "no" });
    const done = await s.waitForRun(runId, ["paused", "failed"]);
    expect(done.run.status).toBe("paused");
    expect(done.nodeRuns.find((n) => n.nodeId === "gate")).toMatchObject({ status: "failed", error: "Approval rejected: no" });
    expect(done.nodeRuns.find((n) => n.nodeId === "after")!.status).toBe("pending");
  });

  it("merges two root lanes; a conflict pauses in a shell until Done", { timeout: 60_000 }, async () => {
    const w = createWorld();
    cleanups.push(() => w.cleanup());
    const s = await E2eServer.start(w);
    cleanups.push(() => s.close());
    const prompt = (file: string, content: string) => ({ prompt: `[[write:${file}:${content}]] Write ${file}` });
    await s.saveGraph({
      version: 1,
      id: "join",
      name: "join",
      settings: { keepWorktrees: "always", defaults: { completion: { mode: "auto", graceSec: 0 } } },
      nodes: [
        { id: "a", type: "prompt", label: "A", position: { x: 0, y: 0 }, config: prompt("README.md", "from a") },
        { id: "b", type: "prompt", label: "B", position: { x: 0, y: 200 }, config: prompt("README.md", "from b") },
        { id: "c", type: "prompt", label: "C", position: { x: 0, y: 400 }, config: prompt("c.txt", "from c") },
        { id: "m", type: "merge", label: "Join", position: { x: 300, y: 0 }, config: { onConflict: "pause" } },
      ],
      edges: [
        { id: "e1", source: "a", target: "m" },
        { id: "e2", source: "b", target: "m" },
        { id: "e3", source: "c", target: "m" },
      ],
    } as never);
    const runId = (await s.startRun("join")).run.id;

    const merge = await s.waitForNode(runId, "m", ["waiting_input", "failed"]);
    expect(merge).toMatchObject({ status: "waiting_input", ptyId: `shell-${merge.id}`, waitingReason: { kind: "merge_conflict" } });
    const detail = await s.getRun(runId);
    const main = detail.lanes.find((l) => l.id === merge.laneId)!;
    fs.writeFileSync(path.join(main.worktreePath, "README.md"), "from a and b\n");
    await s.api("POST", `/api/node-runs/${merge.id}/done`);

    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    const output = done.nodeRuns.find((n) => n.nodeId === "m")!.output!;
    expect(output.conflictedFiles).toEqual(["README.md"]);
    expect(output.sha).toBe(gitIn(w.repo, "rev-parse", main.branch));
    const subjects = gitIn(w.repo, "log", "--first-parent", "--format=%s", "-2", main.branch).split("\n");
    expect(subjects).toEqual(done.lanes.filter((l) => l.id !== main.id).reverse().map((l) => `Merge branch '${l.branch}' into ${main.branch}`));
    expect(done.lanes.filter((l) => l.id !== main.id).map((l) => l.status)).toEqual(["merged", "merged"]);
    expect(gitIn(w.repo, "show", `${main.branch}:README.md`)).toBe("from a and b");
    expect(gitIn(w.repo, "show", `${main.branch}:c.txt`)).toBe("from c");
  });
});
