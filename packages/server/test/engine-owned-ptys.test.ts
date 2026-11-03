import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Lane, PlannedLane, Run } from "@promptgraph/shared";
import { getPaths } from "../src/config/paths.js";
import { Engine } from "../src/engine/engine.js";
import { EventBus, type BusEvents } from "../src/events/bus.js";
import { GraphStore } from "../src/graphs/graph-store.js";
import { PtyManager, type PtyHandle } from "../src/pty/pty-manager.js";
import type { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import { ShellRunner } from "../src/runners/shell-runner.js";
import { openDatabase, Store } from "../src/store/store.js";
import type { LaneManager } from "../src/workspace/lane-manager.js";
import { tempDir, waitFor } from "./helpers.js";
import { FakeLanes, makeGraph } from "./support/engine-fakes.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** FakeLanes whose worktree directories exist, so shell nodes can run in them. */
class DirLanes extends FakeLanes {
  override async createLane(run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    const lane = await super.createLane(run, planned, fromRef);
    fs.mkdirSync(lane.worktreePath, { recursive: true });
    return lane;
  }
}

describe("engines of two repositories sharing one PtyManager (DESIGN §4.2)", () => {
  it("shutting one engine down kills only its own PTYs; the other's node and reopen- PTYs keep running", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const paths = getPaths({ PG_HOME: path.join(t.dir, "pg-home") });
    const bus = new EventBus();
    const store = new Store(openDatabase(":memory:"));
    cleanups.push(() => void store.db.close());
    const ptys = new PtyManager(bus, () => null);
    cleanups.push(() => ptys.killAll());
    const repoChanged: string[] = [];
    bus.on("repo:changed", ({ repoId }) => repoChanged.push(repoId));
    const runUpdates: Array<BusEvents["run:update"]> = [];
    bus.on("run:update", (e) => runUpdates.push(e));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

    const repo = (name: string) => {
      const dir = path.join(t.dir, name);
      fs.mkdirSync(dir);
      const id = `${name}-0000000${name === "a" ? 1 : 2}`;
      const owned = ptys.owned(id);
      const graphs = new GraphStore(dir, bus, id);
      graphs.save(makeGraph([{ id: "s", type: "shell", config: { run: "echo started; sleep 30" } }], []));
      const engine = new Engine({
        store,
        graphs,
        lanes: new DirLanes(store, bus, path.join(dir, "wt")) as unknown as LaneManager,
        ptys: owned,
        runners: { shell: new ShellRunner({ ptys: owned, paths, env }) },
        claude: {} as ClaudeRunner,
        bus,
        paths,
        repo: { id, path: dir, name },
        phase: 1,
        env,
        stopTimeoutMs: 500,
      });
      return { id, dir, owned, engine };
    };
    const a = repo("a");
    const b = repo("b");
    const sleeper = (owner: ReturnType<typeof repo>, id: string): PtyHandle =>
      owner.owned.spawn({ id, file: "sh", args: ["-c", "sleep 30"], cwd: owner.dir, env, logPath: path.join(t.dir, `${id}.log`) });

    const runA = await a.engine.startRun("flow");
    const runB = await b.engine.startRun("flow");
    const nodePty = (runId: string) => {
      const nr = store.listNodeRuns(runId)[0]!;
      return nr.ptyId ? ptys.get(nr.ptyId) : undefined;
    };
    await waitFor(() => nodePty(runA.run.id)?.isLive && nodePty(runB.run.id)?.isLive, 5000);
    const reopenA = sleeper(a, "reopen-a");
    const reopenB = sleeper(b, "reopen-b");
    const unowned = ptys.spawn({ id: "daemon-wide", file: "sh", args: ["-c", "sleep 30"], cwd: t.dir, env, logPath: path.join(t.dir, "d.log") });

    expect(a.owned.list().map((h) => h.id).sort()).toEqual([nodePty(runA.run.id)!.id, "reopen-a"].sort());
    expect(b.owned.get("reopen-a")).toBeUndefined();
    expect(b.owned.get("reopen-b")).toBe(reopenB);
    expect(repoChanged).toContain(a.id);
    expect(repoChanged).toContain(b.id);
    expect(runUpdates.find((e) => e.run.id === runA.run.id)?.repoId).toBe(a.id);
    expect(runUpdates.find((e) => e.run.id === runB.run.id)?.repoId).toBe(b.id);

    const nodeB = nodePty(runB.run.id)!;
    const nodeA = nodePty(runA.run.id)!;
    await a.engine.shutdown();

    expect(nodeA.isLive).toBe(false);
    expect(reopenA.isLive).toBe(false);
    expect(nodeB.isLive).toBe(true);
    expect(reopenB.isLive).toBe(true);
    expect(unowned.isLive).toBe(true);
    expect(store.getRun(runA.run.id)!.status).toBe("paused");
    expect(store.getRun(runB.run.id)!.status).toBe("running");
    expect(store.listNodeRuns(runB.run.id)[0]!.status).toBe("running");

    await b.engine.shutdown();
    expect(nodeB.isLive).toBe(false);
    expect(reopenB.isLive).toBe(false);
    expect(unowned.isLive).toBe(true);
  });
});
