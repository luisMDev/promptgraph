import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphSchema, type KeepWorktrees } from "@promptgraph/shared";
import { getPaths } from "../src/config/paths.js";
import { Engine } from "../src/engine/engine.js";
import { EventBus } from "../src/events/bus.js";
import { GraphStore } from "../src/graphs/graph-store.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import type { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "../src/runners/types.js";
import { openDatabase, Store } from "../src/store/store.js";
import { LaneManager } from "../src/workspace/lane-manager.js";
import { createTempRepo, tempDir, waitFor } from "./helpers.js";

/**
 * Engine + real LaneManager on a temp repo: lane creation, fork checkpoints, workspace setup, merges and
 * cleanup with real git worktrees. Runners are stand-ins (prompt nodes write `<node>.txt`).
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const settle = (result: Promise<RunnerResult>): NodeExecution => ({
  result,
  controls: { done() {}, fail() {}, setHold() {}, cancel: async () => {} },
});

class WriteRunner implements Runner {
  start(ctx: RunnerContext): NodeExecution {
    fs.writeFileSync(path.join(ctx.lane.worktreePath, `${ctx.node.id}.txt`), ctx.node.id);
    return settle(Promise.resolve({ status: "succeeded", output: { text: ctx.node.id } }));
  }
}

/** Sequential pairwise merges of ctx.mergeSources (§18 Q4). */
class MergeAllRunner implements Runner {
  constructor(private readonly lanes: LaneManager) {}
  start(ctx: RunnerContext): NodeExecution {
    const run = async (): Promise<RunnerResult> => {
      let sha = "";
      for (const source of ctx.mergeSources) {
        const attempt = await this.lanes.merge(ctx.lane, source, "merge", `Merge ${source.branch}`);
        if (attempt.status !== "merged") return { status: "failed", error: `conflict in ${attempt.files.join(", ")}` };
        sha = attempt.sha;
      }
      return { status: "succeeded", output: { sha } };
    };
    return settle(run());
  }
}

function setup(keepWorktrees: KeepWorktrees, workspaceSetup?: string) {
  const { repo, cleanup } = createTempRepo();
  const home = tempDir();
  cleanups.push(cleanup, home.cleanup);
  const paths = getPaths({ PG_HOME: home.dir });
  const db = openDatabase(paths.stateDb);
  cleanups.push(() => {
    db.close();
  });
  const store = new Store(db);
  const bus = new EventBus();
  const repoRef = { path: repo, name: path.basename(repo) };
  const lanes = new LaneManager({ store, bus, paths, repo: repoRef });
  const ptys = new PtyManager(bus, () => null);
  const graphs = new GraphStore(repo, bus);
  const engine = new Engine({
    store,
    graphs,
    lanes,
    ptys,
    runners: { prompt: new WriteRunner(), merge: new MergeAllRunner(lanes) },
    claude: {} as ClaudeRunner,
    bus,
    paths,
    repo: repoRef,
    phase: 1,
    env: process.env,
    stopTimeoutMs: 500,
  });
  // Lets finalize/cleanup chains finish before the database closes.
  cleanups.push(() => engine.shutdown());
  graphs.save(
    GraphSchema.parse({
      version: 1,
      id: "flow",
      name: "Flow",
      settings: { keepWorktrees, ...(workspaceSetup ? { workspaceSetup } : {}) },
      nodes: [
        { id: "a", type: "prompt", label: "A", position: { x: 0, y: 0 }, config: { prompt: "a" } },
        { id: "b", type: "prompt", label: "B", position: { x: 200, y: 0 }, config: { prompt: "b" } },
        { id: "c", type: "prompt", label: "C", position: { x: 200, y: 100 }, config: { prompt: "c" } },
        { id: "m", type: "merge", label: "M", position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "ac", source: "a", target: "c" },
        { id: "bm", source: "b", target: "m" },
        { id: "cm", source: "c", target: "m" },
      ],
    }),
  );
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  return { repo, store, engine, git, home: home.dir };
}

describe("Engine lanes with real git worktrees", () => {
  it("forks after a checkpoint, sets up each new lane, merges and cleans up merged branches", async () => {
    const setupLog = path.join(tempDir().dir, "setup.log");
    cleanups.push(() => fs.rmSync(path.dirname(setupLog), { recursive: true, force: true }));
    const s = setup("never", `echo "$PWD" >> '${setupLog}'`);
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => s.store.getRun(run.id)!.cleanedUp, 10_000);
    expect(s.store.getRun(run.id)!.status).toBe("succeeded");

    const lanes = s.engine.getRun(run.id).lanes;
    expect(lanes.map((l) => [l.id, l.index, l.status, l.branch])).toEqual([
      ["main", 0, "removed", `pg/flow/${run.shortId}/main`],
      ["l2", 1, "removed", `pg/flow/${run.shortId}/l2`],
    ]);
    // §9.4: setup ran once per lane, in each worktree; its badge sits on the lane's first node.
    expect(fs.readFileSync(setupLog, "utf8").trim().split("\n").sort()).toEqual(lanes.map((l) => l.worktreePath).sort());
    const firstNodes = s.store.listNodeRuns(run.id).filter((nr) => nr.laneSetup !== null);
    expect(firstNodes.map((nr) => [nr.nodeId, nr.laneSetup]).sort()).toEqual([
      ["a", "succeeded"],
      ["c", "succeeded"],
    ]);

    // Worktrees removed; the merged fork branch deleted; main keeps its own commits.
    for (const lane of lanes) expect(fs.existsSync(lane.worktreePath)).toBe(false);
    const main = lanes[0]!.branch;
    expect(s.git(s.repo, "branch", "--list", "pg/*")).toBe(main);
    expect(s.git(s.repo, "ls-tree", "--name-only", main).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt", "c.txt"]);
    // l2 forked from main's checkpoint after A, so it already had a.txt.
    expect(lanes[1]!.baseRef).toBe(s.git(s.repo, "rev-parse", `${main}~2`));
    expect(s.git(s.repo, "log", "--format=%s", main)).toBe(
      [`Merge pg/flow/${run.shortId}/l2`, "pg: checkpoint after B", "pg: checkpoint after C", "pg: checkpoint after A", "init"].join("\n"),
    );
  });

  it("keeps worktrees per policy and cleans them up on demand", async () => {
    const s = setup("always");
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => s.store.listEvents(run.id).some((e) => e.type === "run.status" && (e.payload as { status: string }).status === "succeeded"), 10_000);
    const lanes = s.engine.getRun(run.id).lanes;
    expect(lanes.map((l) => l.status)).toEqual(["active", "merged"]);
    for (const lane of lanes) expect(fs.existsSync(lane.worktreePath)).toBe(true);

    await s.engine.cleanupRun(run.id);
    expect(s.engine.getRun(run.id).lanes.map((l) => l.status)).toEqual(["removed", "removed"]);
    for (const lane of lanes) expect(fs.existsSync(lane.worktreePath)).toBe(false);
    expect(s.store.getRun(run.id)!.cleanedUp).toBe(true);
    expect(s.git(s.repo, "worktree", "list").split("\n")).toHaveLength(1);
  });
});
