import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createEmptyGraph, type Lane, type Run } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { openDatabase, Store } from "../src/store/store.js";
import { LaneManager } from "../src/workspace/lane-manager.js";
import { createTempRepo, tempDir } from "./helpers.js";

describe("LaneManager", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
  });

  function setup() {
    const { repo, cleanup } = createTempRepo();
    const home = tempDir();
    cleanups.push(cleanup, home.cleanup);
    const paths = getPaths({ PG_HOME: home.dir });
    const db = openDatabase(paths.stateDb);
    cleanups.push(() => db.close());
    const store = new Store(db);
    const lanes = new LaneManager({ store, bus: new EventBus(), paths, repo: { path: repo, name: path.basename(repo) } });
    const run = store.insertRun({ id: "r1", repoPath: repo, graph: createEmptyGraph("demo", "Demo"), graphHash: "h", shortId: "ab12", startedAt: 1 });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    return { repo, store, lanes, run, git };
  }

  const planned = (id: string, index: number) => ({ id, index, parentLaneId: null, forkAfterNodeId: null, firstNodeId: "n" });

  it("creates a worktree lane on its own branch", async () => {
    const { repo, lanes, run, git } = setup();
    const lane = await lanes.createLane(run, planned("main", 0), "main");
    expect(lane).toMatchObject({ branch: "pg/demo/ab12/main", status: "active", baseRef: git(repo, "rev-parse", "main") });
    expect(git(lane.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pg/demo/ab12/main");
  });

  it("checkpoints only dirty lanes", async () => {
    const { lanes, run, git } = setup();
    const lane = await lanes.createLane(run, planned("main", 0), "main");
    expect(await lanes.checkpoint(lane, "Plan")).toBeNull();
    fs.writeFileSync(path.join(lane.worktreePath, "a.txt"), "a");
    const sha = await lanes.checkpoint(lane, "Plan");
    expect(sha).toBe(await lanes.headSha(lane));
    expect(git(lane.worktreePath, "log", "-1", "--format=%s")).toBe("pg: checkpoint after Plan");
  });

  it("diffs committed, modified and untracked changes against the base branch without touching the index", async () => {
    const { lanes, run, git } = setup();
    const lane = await lanes.createLane(run, planned("main", 0), "main");
    fs.writeFileSync(path.join(lane.worktreePath, "committed.txt"), "one\n");
    await lanes.checkpoint(lane, "x");
    fs.appendFileSync(path.join(lane.worktreePath, "README.md"), "more\n");
    fs.writeFileSync(path.join(lane.worktreePath, "new.txt"), "fresh\n");

    const diff = await lanes.diff(lane, "main");
    expect(diff.files.map((f) => `${f.status}:${f.path}:+${f.additions}`).sort()).toEqual([
      "added:committed.txt:+1",
      "added:new.txt:+1",
      "modified:README.md:+1",
    ]);
    expect(diff.patch).toContain("+fresh");
    expect(diff.truncated).toBe(false);
    expect(git(lane.worktreePath, "status", "--porcelain")).toBe("M README.md\n?? new.txt");
  });

  it("createLane replaces a branch and worktree left by an attempt that was never persisted", async () => {
    const { repo, lanes, run, git, store } = setup();
    const first = await lanes.createLane(run, planned("main", 0), "main");
    // Simulate a crash between `worktree add` and the insert: the store forgets the lane.
    store.db.prepare("DELETE FROM lanes WHERE run_id = ? AND id = ?").run(run.id, first.id);
    git(repo, "commit", "-q", "--allow-empty", "-m", "moved on");
    const lane = await lanes.createLane(run, planned("main", 0), "main");
    expect(lane.worktreePath).toBe(first.worktreePath);
    expect(git(lane.worktreePath, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
  });

  it("merges a lane and reports conflicts", async () => {
    const { lanes, run, git } = setup();
    const a = await lanes.createLane(run, planned("main", 0), "main");
    const b = await lanes.createLane(run, planned("l2", 1), "main");
    fs.writeFileSync(path.join(a.worktreePath, "a.txt"), "a");
    fs.writeFileSync(path.join(b.worktreePath, "b.txt"), "b");
    expect(await lanes.merge(a, b, "merge", "merge l2")).toMatchObject({ status: "merged" });
    expect(fs.existsSync(path.join(a.worktreePath, "b.txt"))).toBe(true);

    const c = await lanes.createLane(run, planned("l3", 2), "main");
    fs.writeFileSync(path.join(a.worktreePath, "README.md"), "mine\n");
    fs.writeFileSync(path.join(c.worktreePath, "README.md"), "theirs\n");
    const attempt = await lanes.merge(a, c, "merge", "merge l3");
    const before = git(a.worktreePath, "rev-parse", "HEAD");
    expect(attempt).toEqual({ status: "conflict", files: ["README.md"], head: before });
    // Left mid-merge (e.g. a crash): checkpoints refuse to commit the markers; resetInterruptedMerge drops it.
    await expect(lanes.checkpoint(a, "x")).rejects.toThrow(/middle of a merge/);
    expect(await lanes.resetInterruptedMerge(a)).toBe(true);
    expect(git(a.worktreePath, "status", "--porcelain")).toBe("");
    expect(git(a.worktreePath, "rev-parse", "HEAD")).toBe(before);
    expect(await lanes.resetInterruptedMerge(a)).toBe(false);
  });

  it("a squash merge with nothing new leaves no pending squash behind", async () => {
    const { lanes, run } = setup();
    const a = await lanes.createLane(run, planned("main", 0), "main");
    const b = await lanes.createLane(run, planned("l2", 1), "main");
    for (const lane of [a, b]) fs.writeFileSync(path.join(lane.worktreePath, "same.txt"), "same\n");
    expect(await lanes.merge(a, b, "squash", "merge l2")).toMatchObject({ status: "merged" });
    fs.writeFileSync(path.join(a.worktreePath, "next.txt"), "n");
    expect(await lanes.checkpoint(a, "next")).toEqual(expect.any(String));
  });

  it("cleanup removes worktrees and keeps only branches with their own commits", async () => {
    const { repo, store, lanes, run, git } = setup();
    const kept = await lanes.createLane(run, planned("main", 0), "main");
    const empty = await lanes.createLane(run, planned("l2", 1), "main");
    fs.writeFileSync(path.join(kept.worktreePath, "work.txt"), "w");
    await lanes.checkpoint(kept, "x");

    await lanes.cleanup(run.id, { keep: "on-failure", failed: true });
    expect(fs.existsSync(kept.worktreePath)).toBe(true); // policy keeps failed runs

    await lanes.cleanup(run.id, { keep: "on-failure", failed: false });
    for (const lane of [kept, empty]) expect(fs.existsSync(lane.worktreePath)).toBe(false);
    expect(git(repo, "branch", "--list", "pg/*")).toBe("pg/demo/ab12/main");
    expect(store.listLanes(run.id).map((l: Lane) => l.status)).toEqual(["removed", "removed"]);
    expect((store.getRun(run.id) as Run).cleanedUp).toBe(true);
  });

  it("cleanup keeps pushed branches, deletes merged ones and honours keep: always unless forced", async () => {
    const { repo, store, lanes, run, git } = setup();
    const pushed = await lanes.createLane(run, planned("main", 0), "main");
    const merged = await lanes.createLane(run, planned("l2", 1), "main");
    fs.writeFileSync(path.join(merged.worktreePath, "m.txt"), "m");
    expect(await lanes.merge(pushed, merged, "merge", "merge l2")).toMatchObject({ status: "merged" });
    // Pretend main was pushed without commits of its own (pushed branches always survive cleanup).
    await lanes.withLaneLock(pushed, async () => git(pushed.worktreePath, "reset", "-q", "--hard", pushed.baseRef));
    store.updateLane(run.id, pushed.id, { pushed: true });

    await lanes.cleanup(run.id, { keep: "always", failed: false });
    expect(store.listLanes(run.id).map((l: Lane) => l.status)).toEqual(["active", "merged"]);

    await lanes.cleanup(run.id, { keep: "always", failed: false, force: true });
    expect(store.listLanes(run.id).map((l: Lane) => l.status)).toEqual(["removed", "removed"]);
    expect(git(repo, "branch", "--list", "pg/*")).toBe("pg/demo/ab12/main");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });
});
