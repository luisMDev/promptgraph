import fs from "node:fs";
import path from "node:path";
import { createEmptyGraph, GraphSchema } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repoIdFor } from "../src/config/repo-id.js";
import { repoKey } from "../src/config/repo-key.js";
import { REPOS_BACKFILLED_KEY } from "../src/daemon/registry.js";
import { Engine } from "../src/engine/engine.js";
import { GraphStore } from "../src/graphs/graph-store.js";
import { createTempRepo, fakeClaudeEnv, tempDir, waitFor } from "./helpers.js";
import { chainGraph } from "./e2e/harness.js";
import { createTestDaemon, type TestDaemon } from "./support/test-daemon.js";

describe("RepoRegistry (DESIGN §4.2, §4.4)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });

  function repo(prefix = "pg-reg-"): string {
    const r = createTempRepo(prefix);
    cleanups.push(r.cleanup);
    return r.repo;
  }

  async function daemon(env: NodeJS.ProcessEnv = {}): Promise<TestDaemon & { root: string }> {
    const t = tempDir("pg-reg-home-");
    cleanups.push(t.cleanup);
    const d = await createTestDaemon({ root: t.dir, env: { ...process.env, ...fakeClaudeEnv(t.dir), ...env } });
    cleanups.push(() => d.close());
    return Object.assign(d, { root: t.dir });
  }

  it("loading has no side effects: no .promptgraph dir, no watcher, no git write", async () => {
    const d = await daemon();
    const r = repo();
    const id = repoIdFor(r);
    d.ctx.store.insertRepo({ id, path: r, name: path.basename(r), addedAt: 1 });
    const watch = vi.spyOn(GraphStore.prototype, "watch");
    const prune = vi.spyOn(Engine.prototype, "prune");
    const ctx = await d.ctx.registry.load(id);
    expect(ctx.graphs.list()).toEqual([]);
    expect(fs.existsSync(path.join(r, ".promptgraph"))).toBe(false);
    expect(watch).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(d.ctx.registry.summary(id)).toMatchObject({ active: false, available: true, error: null });
    expect(await d.ctx.registry.load(id)).toBe(ctx);
  });

  it("concurrent first requests build one context and activate it once", async () => {
    const d = await daemon();
    const r = repo();
    const id = repoIdFor(r);
    d.ctx.store.insertRepo({ id, path: r, name: "x", addedAt: 1 });
    const prune = vi.spyOn(Engine.prototype, "prune");
    const watch = vi.spyOn(GraphStore.prototype, "watch");
    const [a, b, c] = await Promise.all([d.ctx.registry.activate(id), d.ctx.registry.activate(id), d.ctx.registry.load(id)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await d.ctx.registry.add(r);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(d.ctx.registry.summary(id)).toMatchObject({ active: true });
  });

  it("dedupes symlinks, refuses relative paths and non-repositories, expands ~", async () => {
    const home = tempDir("pg-reg-userhome-");
    cleanups.push(home.cleanup);
    const d = await daemon({ HOME: home.dir });
    const r = repo();
    const link = path.join(home.dir, "link");
    fs.symlinkSync(r, link);
    const viaLink = await d.ctx.registry.add(link);
    const direct = await d.ctx.registry.add(path.join(r, "."));
    expect(viaLink.id).toBe(direct.id);
    expect(viaLink.path).toBe(r);
    expect(d.ctx.registry.list()).toHaveLength(1);
    expect((await d.ctx.registry.add("~/link")).id).toBe(direct.id);
    await expect(d.ctx.registry.add("relative/dir")).rejects.toMatchObject({ status: 422, code: "path_not_absolute" });
    await expect(d.ctx.registry.add(home.dir)).rejects.toMatchObject({ status: 422, code: "not_a_git_repo" });
    await expect(d.ctx.registry.add("/nonexistent/pg-nowhere")).rejects.toMatchObject({ status: 422, code: "not_a_git_repo" });
    await expect(d.ctx.registry.load("nope-0123abcd")).rejects.toMatchObject({ status: 404, code: "unknown_repo" });
  });

  it("refuses to remove a repository with a running run; force stops only its own runs and PTYs", { timeout: 30_000 }, async () => {
    const d = await daemon();
    const a = await d.ctx.registry.add(repo("pg-reg-a-"));
    const b = await d.ctx.registry.add(repo("pg-reg-b-"));
    const start = async (id: string) => {
      const ctx = await d.ctx.registry.load(id);
      ctx.graphs.save(GraphSchema.parse(chainGraph("slow", [{ id: "wait", type: "shell", config: { run: "sleep 30" } }])));
      const run = await ctx.engine.startRun("slow");
      const nr = run.nodeRuns[0]!;
      await waitFor(() => d.ctx.ptys.get(nr.id)?.isLive);
      return { runId: run.run.id, nodeRunId: nr.id };
    };
    const runA = await start(a.id);
    const runB = await start(b.id);
    expect(d.ctx.registry.summary(a.id)).toMatchObject({ runs: { running: 1, paused: 0 } });

    await expect(d.ctx.registry.remove(a.id)).rejects.toMatchObject({ status: 409, code: "repo_active" });
    const removed: string[] = [];
    d.ctx.bus.on("repo:removed", ({ repoId }) => removed.push(repoId));
    await d.ctx.registry.remove(a.id, { force: true });

    expect(removed).toEqual([a.id]);
    expect(d.ctx.store.getRun(runA.runId)?.status).toBe("paused");
    expect(d.ctx.store.getNodeRun(runA.nodeRunId)?.status).toBe("interrupted");
    expect(d.ctx.ptys.get(runA.nodeRunId)?.isLive).toBe(false);
    expect(d.ctx.ptys.get(runB.nodeRunId)?.isLive).toBe(true);
    expect(d.ctx.store.getRun(runB.runId)?.status).toBe("running");
    expect(d.ctx.registry.row(a.id)).toBeUndefined();
    await expect(d.ctx.registry.load(a.id)).rejects.toMatchObject({ code: "unknown_repo" });
    await (await d.ctx.registry.load(b.id)).engine.cancelRun(runB.runId);
  });

  it("a re-add during a force-remove waits for the dispose and gets the same id and history back", { timeout: 30_000 }, async () => {
    const d = await daemon();
    const r = repo();
    const a = await d.ctx.registry.add(r);
    const ctx = await d.ctx.registry.load(a.id);
    ctx.graphs.save(GraphSchema.parse(chainGraph("slow", [{ id: "wait", type: "shell", config: { run: "sleep 30" } }])));
    const run = await ctx.engine.startRun("slow");
    await waitFor(() => d.ctx.ptys.get(run.nodeRuns[0]!.id)?.isLive);

    const events: string[] = [];
    d.ctx.bus.on("repo:removed", () => events.push("removed"));
    d.ctx.bus.on("repo:changed", () => events.push("changed"));
    const removing = d.ctx.registry.remove(a.id, { force: true });
    const readding = d.ctx.registry.add(r);
    const loading = d.ctx.registry.load(a.id);
    const [, again, loaded] = await Promise.all([removing, readding, loading.catch((e: unknown) => e)]);
    // The add's registration comes after the removal finished.
    expect(events).toContain("removed");
    expect(events.lastIndexOf("changed")).toBeGreaterThan(events.indexOf("removed"));
    expect(again.id).toBe(a.id);
    expect(again.runs).toEqual({ running: 0, paused: 1 });
    // The load issued during the removal waited for it, then found the repository gone (re-added after).
    expect(loaded).toMatchObject({ code: "unknown_repo" });
    const fresh = await d.ctx.registry.load(a.id);
    expect(fresh).not.toBe(ctx);
    expect(d.ctx.store.listRuns({ repoPath: r, limit: 10 }).map((x) => x.id)).toEqual([run.run.id]);
  });

  it("keeps a repository whose directory is gone, as unavailable", async () => {
    const d = await daemon();
    const r = createTempRepo("pg-reg-gone-");
    const a = await d.ctx.registry.add(r.repo);
    r.cleanup();
    expect(d.ctx.registry.list()).toEqual([expect.objectContaining({ id: a.id, available: false })]);
    await expect(d.ctx.registry.load(a.id)).rejects.toMatchObject({ status: 409, code: "repo_unavailable" });
  });

  it("an activation racing a removal never re-takes the legacy lock nor resurrects the repository", async () => {
    const d = await daemon();
    const r = repo();
    const id = repoIdFor(r);
    d.ctx.store.insertRepo({ id, path: r, name: "x", addedAt: 1 });
    const lockFile = path.join(d.ctx.paths.home, "locks", `${repoKey(r)}.pid`);
    // The activation is still loading when the removal starts.
    const activation = d.ctx.registry.activate(id);
    await d.ctx.registry.remove(id);
    await expect(activation).rejects.toMatchObject({ status: 404, code: "unknown_repo" });
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.existsSync(path.join(r, ".promptgraph"))).toBe(false);
    expect(d.ctx.registry.list()).toEqual([]);
    expect(d.ctx.registry.summary(id)).toBeNull();
  });

  it("an add whose repository is removed while it activates answers 404, never a null summary", async () => {
    const d = await daemon();
    const r = repo();
    const id = repoIdFor(r);
    let removing: Promise<void> | undefined;
    // repo:changed is emitted right before add() awaits the activation.
    d.ctx.bus.on("repo:changed", ({ repoId }) => {
      if (repoId === id) removing ??= d.ctx.registry.remove(id, { force: true });
    });
    await expect(d.ctx.registry.add(r)).rejects.toMatchObject({ status: 404, code: "unknown_repo" });
    await removing;
    expect(d.ctx.registry.list()).toEqual([]);
  });

  it("a successful load clears the error a previous failed load left", async () => {
    const d = await daemon();
    const r = repo();
    const id = repoIdFor(r);
    d.ctx.store.insertRepo({ id, path: r, name: "x", addedAt: 1 });
    const deps = (d.ctx.registry as unknown as { deps: { createContext: (...a: unknown[]) => unknown } }).deps;
    const create = deps.createContext;
    deps.createContext = () => {
      throw new Error("boom");
    };
    await expect(d.ctx.registry.load(id)).rejects.toThrow("boom");
    expect(d.ctx.registry.summary(id)?.error).toBe("boom");
    deps.createContext = create;
    const changed: string[] = [];
    d.ctx.bus.on("repo:changed", ({ repoId }) => changed.push(repoId));
    await d.ctx.registry.load(id);
    expect(d.ctx.registry.summary(id)?.error).toBeNull();
    expect(changed).toEqual([id]);
  });

  it("refuses to load, activate or add once the daemon is stopping", async () => {
    const d = await daemon();
    const r = repo();
    const id = repoIdFor(r);
    d.ctx.store.insertRepo({ id, path: r, name: "x", addedAt: 1 });
    await d.ctx.registry.shutdownAll();
    const stopping = { status: 503, code: "daemon_stopping" };
    await expect(d.ctx.registry.load(id)).rejects.toMatchObject(stopping);
    await expect(d.ctx.registry.activate(id)).rejects.toMatchObject(stopping);
    await expect(d.ctx.registry.add(r)).rejects.toMatchObject(stopping);
    expect(fs.existsSync(path.join(r, ".promptgraph"))).toBe(false);
  });

  describe("backfill", () => {
    function insertRun(d: TestDaemon, repoPath: string, id: string): void {
      d.ctx.store.insertRun({ id, repoPath, graph: createEmptyGraph("g", "G"), graphHash: "h", shortId: id.slice(0, 4), startedAt: 1 });
    }

    it("registers run repositories once, normalises symlinked paths and never resurrects a removed repository", async () => {
      const d = await daemon();
      const r = repo();
      const link = path.join(d.root, "link-to-repo");
      fs.symlinkSync(r, link);
      const notRepo = tempDir("pg-reg-plain-");
      cleanups.push(notRepo.cleanup);
      insertRun(d, link, "run-link-1");
      insertRun(d, notRepo.dir, "run-plain-1");
      insertRun(d, "/nonexistent/pg-gone", "run-gone-1");
      d.ctx.store.setKnownGraphHash(link, "g", "h1");

      await d.ctx.registry.backfill();
      expect(d.ctx.store.getMeta(REPOS_BACKFILLED_KEY)).toBe("1");
      expect(d.ctx.store.getRunRepoPath("run-link-1")).toBe(r);
      expect(d.ctx.store.getKnownGraphHash(r, "g")).toBe("h1");
      expect(d.ctx.store.getKnownGraphHash(link, "g")).toBeUndefined();
      expect(d.ctx.registry.list().map((x) => x.path)).toEqual([r]);

      await d.ctx.registry.remove(repoIdFor(r), { force: true });
      await d.ctx.registry.backfill();
      expect(d.ctx.registry.list()).toEqual([]);
    });

    it("a crash before the commit leaves nothing behind and is retried", async () => {
      const d = await daemon();
      const r = repo();
      insertRun(d, r, "run-1");
      const setMeta = vi.spyOn(d.ctx.store, "setMeta").mockImplementationOnce(() => {
        throw new Error("simulated crash");
      });
      await expect(d.ctx.registry.backfill()).rejects.toThrow("simulated crash");
      expect(d.ctx.registry.list()).toEqual([]);
      expect(d.ctx.store.getMeta(REPOS_BACKFILLED_KEY)).toBeUndefined();
      setMeta.mockRestore();
      await d.ctx.registry.backfill();
      expect(d.ctx.registry.list().map((x) => x.path)).toEqual([r]);
    });
  });
});
