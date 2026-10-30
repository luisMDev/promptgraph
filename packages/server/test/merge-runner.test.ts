import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createEmptyGraph, emptyUsage, type Lane, type NodeRunOutput, type Run } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths, type PgPaths } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { HookRouter } from "../src/hooks/hook-router.js";
import { hookToken } from "../src/hooks/hook-token.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import { installPgHook } from "../src/runners/claude/pg-hook.js";
import { conflictPrompt, MergeRunner } from "../src/runners/git/merge-runner.js";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "../src/runners/types.js";
import { openDatabase, Store } from "../src/store/store.js";
import { LaneManager } from "../src/workspace/lane-manager.js";
import { createTempRepo, fakeClaudeEnv, tempDir, waitFor } from "./helpers.js";
import { makeCtx, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (lane: Lane, file: string, content: string) => fs.writeFileSync(path.join(lane.worktreePath, file), content);
const read = (lane: Lane, file: string) => fs.readFileSync(path.join(lane.worktreePath, file), "utf8");

function setup() {
  const { repo, cleanup } = createTempRepo();
  const home = tempDir();
  cleanups.push(cleanup, home.cleanup);
  const paths = getPaths({ PG_HOME: home.dir });
  const db = openDatabase(paths.stateDb);
  cleanups.push(() => void db.close());
  const store = new Store(db);
  const bus = new EventBus();
  const lanes = new LaneManager({ store, bus, paths, repo: { path: repo, name: path.basename(repo) } });
  const ptys = new PtyManager(bus, () => null);
  cleanups.push(() => ptys.killAll());
  const run = store.insertRun({ id: "run1", repoPath: repo, graph: createEmptyGraph("demo", "Demo"), graphHash: "h", shortId: "ab12", startedAt: 1 });
  const lane = (id: string, index: number) => lanes.createLane(run, { id, index, parentLaneId: null, forkAfterNodeId: null, firstNodeId: id }, "main");
  return { repo, home: home.dir, paths, store, lanes, ptys, run, lane };
}

type Setup = ReturnType<typeof setup>;

/** A Runner standing in for the ClaudeRunner: runs `act` in the worktree, then returns `result`. */
function scriptedClaude(act: (ctx: RunnerContext) => void, result: RunnerResult): Runner & { contexts: RunnerContext[] } {
  const contexts: RunnerContext[] = [];
  return {
    contexts,
    start(ctx): NodeExecution {
      contexts.push(ctx);
      ctx.update({ ptyId: ctx.nodeRun.id, status: "running" });
      act(ctx);
      return {
        result: Promise.resolve(result),
        controls: { done: () => undefined, fail: () => undefined, setHold: () => undefined, cancel: async () => undefined },
      };
    },
  };
}

const neverClaude: Runner = {
  start: () => {
    throw new Error("Claude must not be started");
  },
};

function startMerge(s: Setup, target: Lane, mergeSources: Lane[], config: Record<string, unknown>, claude: Runner = neverClaude, paths: PgPaths = s.paths) {
  const run: Run = { ...makeRun({ nodes: [{ id: "m", type: "merge", label: "Merge", config } as never] }), id: s.run.id };
  const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: target, mergeSources, nodeRunId: "nr-m" });
  const exec = new MergeRunner({ lanes: s.lanes, ptys: s.ptys, claude, paths, env: { ...process.env, SHELL: "/bin/sh" } }).start(ctx);
  return { ctx, exec };
}

/** main and l2 both rewrite README.md → conflict when l2 is merged into main. */
async function conflicting(s: Setup) {
  const main = await s.lane("main", 0);
  const l2 = await s.lane("l2", 1);
  write(main, "README.md", "mine\n");
  write(l2, "README.md", "theirs\n");
  return { main, l2 };
}

/** Aborted: HEAD is the pre-merge checkpoint of the dirty lane, nothing staged or mid-merge. */
function expectPreMergeState(lane: Lane): void {
  expect(git(lane.worktreePath, "log", "-1", "--format=%s")).toBe("pg: checkpoint after merge");
  expect(read(lane, "README.md")).toBe("mine\n");
}

describe("MergeRunner", () => {
  it("merges the other input lanes one by one in canvas order with --no-ff and marks them merged", async () => {
    const s = setup();
    const main = await s.lane("main", 0);
    const l2 = await s.lane("l2", 1);
    const l3 = await s.lane("l3", 2);
    write(main, "a.txt", "a");
    write(l2, "b.txt", "b");
    write(l3, "c.txt", "c");
    const { exec } = startMerge(s, main, [l3, l2], { strategy: "merge" });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { sha: git(main.worktreePath, "rev-parse", "HEAD"), conflictedFiles: [] } });
    expect(git(main.worktreePath, "log", "--first-parent", "--format=%s", "-2").split("\n")).toEqual([
      `Merge branch '${l2.branch}' into ${main.branch}`,
      `Merge branch '${l3.branch}' into ${main.branch}`,
    ]);
    expect(read(main, "b.txt") + read(main, "c.txt")).toBe("bc");
    expect(s.store.getLane("run1", "l2")!.status).toBe("merged");
    expect(s.store.getLane("run1", "l3")!.status).toBe("merged");
    expect(s.store.getLane("run1", "main")!.status).toBe("active");
  });

  it("squash creates one ordinary commit", async () => {
    const s = setup();
    const main = await s.lane("main", 0);
    const l2 = await s.lane("l2", 1);
    write(l2, "b.txt", "b");
    const { exec } = startMerge(s, main, [l2], { strategy: "squash" });
    expect((await exec.result).status).toBe("succeeded");
    expect(git(main.worktreePath, "log", "-1", "--format=%P").split(" ")).toHaveLength(1);
    expect(git(main.worktreePath, "log", "-1", "--format=%s")).toBe(`Merge branch '${l2.branch}' into ${main.branch}`);
    expect(read(main, "b.txt")).toBe("b");
  });

  it("onConflict claude: runs the resolver with the §9.5 prompt, commits with --no-edit and sums its usage", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const usage = { ...emptyUsage(), outputTokens: 5, costUsd: 0.01, model: "claude-haiku-4-5" };
    const claude = scriptedClaude(
      (ctx) => {
        write(main, "README.md", "both\n");
        git(ctx.lane.worktreePath, "add", "README.md");
      },
      { status: "succeeded", output: { text: "Resolved", usage } },
    );
    const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "claude" }, claude);
    let slots = 0;
    ctx.claudeSlot = async () => void slots++;
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { conflictedFiles: ["README.md"], usage: { outputTokens: 5 } } });
    expect(slots).toBe(1);
    const sent = claude.contexts[0]!;
    expect(sent.node).toMatchObject({ id: "m", type: "prompt", config: { prompt: conflictPrompt(["README.md"]), context: "clean" } });
    expect(sent.lane).toBe(main);
    expect(ctx.current.ptyId).toBe("nr-m");
    expect(git(main.worktreePath, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(git(main.worktreePath, "log", "-1", "--format=%s")).toContain(l2.branch);
    expect(read(main, "README.md")).toBe("both\n");
    expect(s.store.getLane("run1", "l2")!.status).toBe("merged");
  });

  it("onConflict claude: markers left behind fail the node and abort the merge", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const claude = scriptedClaude(() => undefined, { status: "succeeded", output: {} });
    const { exec } = startMerge(s, main, [l2], { onConflict: "claude" }, claude);
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", error: "Unresolved merge conflicts remain in: README.md", output: { conflictedFiles: ["README.md"] } });
    expectPreMergeState(main);
    expect(git(main.worktreePath, "status", "--porcelain")).toBe("");
    expect(s.store.getLane("run1", "l2")!.status).toBe("active");
  });

  it("onConflict claude: a resolver that aborts the merge fails the node and keeps the source unmerged", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const claude = scriptedClaude((ctx) => git(ctx.lane.worktreePath, "merge", "--abort"), { status: "succeeded", output: {} });
    const { exec } = startMerge(s, main, [l2], { onConflict: "claude" }, claude);
    expect(await exec.result).toMatchObject({ status: "failed", error: expect.stringContaining("was abandoned") });
    expectPreMergeState(main);
    expect(s.store.getLane("run1", "l2")!.status).toBe("active");
  });

  it("onConflict claude: a resolver that commits the markers is reset to the pre-merge HEAD", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const claude = scriptedClaude((ctx) => git(ctx.lane.worktreePath, "commit", "-q", "-am", "oops"), { status: "succeeded", output: {} });
    const { exec } = startMerge(s, main, [l2], { onConflict: "claude" }, claude);
    expect(await exec.result).toMatchObject({ status: "failed", error: "Unresolved merge conflicts remain in: README.md" });
    expectPreMergeState(main);
    expect(git(main.worktreePath, "status", "--porcelain")).toBe("");
  });

  it("onConflict claude: a failed resolver fails the node", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const claude = scriptedClaude(() => undefined, { status: "failed", error: "Claude exited unexpectedly (code 1)" });
    const { exec } = startMerge(s, main, [l2], { onConflict: "claude" }, claude);
    expect(await exec.result).toMatchObject({ status: "failed", error: "Claude could not resolve the merge conflicts: Claude exited unexpectedly (code 1)" });
    expect(git(main.worktreePath, "status", "--porcelain")).toBe("");
  });

  it("onConflict claude: fail() while waiting for a Claude slot aborts the merge", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "claude" });
    let waiting = false;
    ctx.claudeSlot = () => {
      waiting = true;
      return new Promise<void>(() => undefined);
    };
    await waitFor(() => waiting);
    exec.controls.fail("too slow");
    expect(await exec.result).toMatchObject({ status: "failed", error: "too slow", output: { conflictedFiles: ["README.md"] } });
    expectPreMergeState(main);
  });

  it("onConflict pause: waits in a shell, re-checks on Done and commits once resolved", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "pause" });
    await waitFor(() => ctx.current.status === "waiting_input");
    expect(ctx.current.waitingReason).toMatchObject({ kind: "merge_conflict", message: expect.stringContaining("README.md") });
    expect(ctx.current.ptyId).toBe("shell-nr-m");
    const shell = s.ptys.get("shell-nr-m")!;
    expect(shell.isLive).toBe(true);

    // Done with markers still present keeps waiting.
    exec.controls.done();
    await waitFor(() => ctx.current.waitingReason?.message.startsWith("Unresolved"));
    expect(ctx.current.status).toBe("waiting_input");

    // Resolve from the shell (unstaged: Done stages the conflicted files).
    shell.write("printf 'merged\\n' > README.md\r");
    await waitFor(() => read(main, "README.md") === "merged\n");
    exec.controls.done();
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { conflictedFiles: ["README.md"] } });
    expect(ctx.current.status).toBe("running");
    expect(git(main.worktreePath, "log", "-1", "--format=%s")).toContain(l2.branch);
    expect(git(main.worktreePath, "status", "--porcelain")).toBe("");
    await waitFor(() => !shell.isLive);
  });

  it("onConflict pause with squash: commits the resolution with the merge message", async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "pause", strategy: "squash" });
    await waitFor(() => ctx.current.status === "waiting_input");
    write(main, "README.md", "merged\n");
    exec.controls.done();
    expect((await exec.result).status).toBe("succeeded");
    expect(git(main.worktreePath, "log", "-1", "--format=%s")).toBe(`Merge branch '${l2.branch}' into ${main.branch}`);
    expect(git(main.worktreePath, "log", "-1", "--format=%P").split(" ")).toHaveLength(1);
  });

  it("onConflict pause: a merge abandoned in the shell fails the node instead of reporting it merged", async () => {
    for (const [strategy, abandon] of [["merge", ["merge", "--abort"]], ["squash", ["reset", "-q", "--hard"]]] as const) {
      const s = setup();
      const { main, l2 } = await conflicting(s);
      const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "pause", strategy });
      await waitFor(() => ctx.current.status === "waiting_input");
      git(main.worktreePath, ...abandon);
      exec.controls.done();
      expect(await exec.result).toMatchObject({ status: "failed", error: expect.stringContaining("was abandoned") });
      expectPreMergeState(main);
      expect(s.store.getLane("run1", "l2")!.status).toBe("active");
    }
  });

  it("onConflict pause: Fail aborts the merge (squash too) and cancel aborts it", async () => {
    for (const strategy of ["merge", "squash"]) {
      const s = setup();
      const { main, l2 } = await conflicting(s);
      const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "pause", strategy });
      await waitFor(() => ctx.current.status === "waiting_input");
      exec.controls.fail("give up");
      expect(await exec.result).toMatchObject({ status: "failed", error: "give up" });
      expectPreMergeState(main);
      expect(git(main.worktreePath, "status", "--porcelain")).toBe("");
      await waitFor(() => !s.ptys.get("shell-nr-m")!.isLive);
    }
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "pause" });
    await waitFor(() => ctx.current.status === "waiting_input");
    await exec.controls.cancel();
    expect(await exec.result).toEqual({ status: "cancelled" });
    expect(git(main.worktreePath, "status", "--porcelain")).toBe("");
  });
});

describe("MergeRunner + ClaudeRunner (fake claude)", () => {
  it("resolves a conflict through a real Claude PTY", { timeout: 30_000 }, async () => {
    const s = setup();
    const { main, l2 } = await conflicting(s);
    const t = tempDir();
    cleanups.push(t.cleanup);
    const claudeLog = path.join(t.dir, "claude.log");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...fakeClaudeEnv(t.dir, { FAKE_CLAUDE_LOG: claudeLog }),
      FAKE_CLAUDE_MODE: "[[bash:printf 'resolved\\n' > README.md && git add README.md]]",
    };
    const paths = getPaths(env);
    const hooks = new HookRouter();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const m = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
        if (m && req.headers.authorization === `Bearer ${hookToken("tok", m[1]!)}`) {
          hooks.dispatch(m[1]!, m[2]!, JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        }
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as AddressInfo).port;
    const claude = new ClaudeRunner({ ptys: s.ptys, hooks, paths, pgHookPath: installPgHook(paths), endpoint: () => ({ port, token: "tok" }), env });

    const { ctx, exec } = startMerge(s, main, [l2], { onConflict: "claude" }, claude, paths);
    // makeRun's default completion is auto with a grace period; Done ends it right after the turn.
    await waitFor(() => ctx.current.status === "idle" || (ctx.current.output as NodeRunOutput | null)?.text, 15_000);
    exec.controls.done();
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { conflictedFiles: ["README.md"], usage: { outputTokens: 34 } } });
    expect(read(main, "README.md")).toBe("resolved\n");
    expect(git(main.worktreePath, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    const argv = (JSON.parse(fs.readFileSync(claudeLog, "utf8").split("\n")[0]!) as { argv: string[] }).argv;
    expect(argv[0]).toBe(conflictPrompt(["README.md"]));
    expect(argv).toEqual(expect.arrayContaining(["--name", "pg:g1/Merge"]));
  });
});
