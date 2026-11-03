import fs from "node:fs";
import path from "node:path";
import type { RepoSummary, ServerMessage } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../../src/config/paths.js";
import { repoKey } from "../../src/config/repo-key.js";
import { DaemonLockedError, startDaemon } from "../../src/daemon/start.js";
import { createTempRepo } from "../helpers.js";
import { acquirePreM7Lock } from "../support/legacy-lock.js";
import { chainGraph, createWorld, E2eServer, type E2eWorld } from "./harness.js";

/** One daemon manages several repositories; each repository only sees its own runs (DESIGN §4). */
describe("e2e: two repositories in one daemon", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function world(): E2eWorld {
    const w = createWorld();
    cleanups.push(() => w.cleanup());
    return w;
  }

  function otherRepo(prefix: string): string {
    const r = createTempRepo(prefix);
    cleanups.push(r.cleanup);
    return r.repo;
  }

  it("runs both concurrently, scopes ids and WS events by repository, and owns the legacy locks", { timeout: 40_000 }, async () => {
    const w = world();
    const a = await E2eServer.start(w);
    cleanups.push(() => a.close());
    const b = await a.addRepo(otherRepo("pg-e2e-b-"));
    expect(b.repoId).not.toBe(a.repoId);
    const wsA = await a.connectWs();
    cleanups.push(() => wsA.close());

    const slow = chainGraph("slow", [{ id: "wait", type: "shell", config: { run: "sleep 1.5; echo done" } }]);
    await a.saveGraph(slow);
    await b.saveGraph(slow);
    const runA = (await a.startRun("slow")).run.id;
    const runB = (await b.startRun("slow")).run.id;
    await a.waitForNode(runA, "wait", ["running"]);
    await b.waitForNode(runB, "wait", ["running"]);

    // Run ids are global, but addressed under their repository: the other repository's engine does not know them.
    const cross = await b.request("GET", `/api/runs/${runA}`);
    expect(cross.status).toBe(404);
    expect((await a.request("POST", `/api/runs/${runB}/cancel`)).status).toBe(404);
    const listedB = await b.api<{ runs: Array<{ id: string }> }>("GET", "/api/runs");
    expect(listedB.runs.map((r) => r.id)).toEqual([runB]);

    // A pre-M7 binary started for a registered repository fails before it can touch the DB.
    expect(() => acquirePreM7Lock(getPaths(w.env), a.server.ctx.registry.row(a.repoId)!.path)).toThrow(/already running/);

    expect((await a.waitForRun(runA, ["succeeded", "failed", "paused"])).run.status).toBe("succeeded");
    expect((await b.waitForRun(runB, ["succeeded", "failed", "paused"])).run.status).toBe("succeeded");
    // The socket subscribed to A got A's run updates and none of B's; repo:status goes to everyone.
    const runUpdates = wsA.messages.filter((m): m is Extract<ServerMessage, { type: "run:update" }> => m.type === "run:update");
    expect(runUpdates.some((m) => m.run.id === runA)).toBe(true);
    expect(runUpdates.every((m) => m.repoId === a.repoId)).toBe(true);
    await wsA.waitFor((m) => m.type === "repo:status" && m.repo.id === b.repoId);
  });

  it("refuses a second daemon on the same PG_HOME and a start while a legacy server runs", async () => {
    const w = world();
    const a = await E2eServer.start(w);
    cleanups.push(() => a.close());
    const second = startDaemon({ port: 0, env: w.env, token: "x" });
    await expect(second).rejects.toBeInstanceOf(DaemonLockedError);
    await expect(second).rejects.toThrow(`promptgraph daemon is already running (pid ${process.pid})`);

    // Another PG_HOME with a live pre-M7 server record (this test process plays the old server).
    const w2 = world();
    const paths = getPaths(w2.env);
    const legacyRepo = otherRepo("pg-e2e-legacy-");
    fs.mkdirSync(path.join(paths.home, "servers"), { recursive: true });
    const record = { version: 1, pid: process.pid, repoPath: legacyRepo, port: 1, token: "t", serverVersion: "0.0.1", startedAt: Date.now() };
    fs.writeFileSync(path.join(paths.home, "servers", `${repoKey(legacyRepo)}.json`), JSON.stringify(record));
    await expect(startDaemon({ port: 0, env: w2.env, token: "x" })).rejects.toThrow(`stop the promptgraph server for ${legacyRepo} (pid ${process.pid}) first`);
    // The failed start released the daemon lock.
    fs.rmSync(path.join(paths.home, "servers"), { recursive: true });
    const ok = await startDaemon({ port: 0, env: w2.env, token: "x" });
    await ok.close();
  });

  it("an activation failure in one repository leaves the others working", { timeout: 30_000 }, async () => {
    const w = world();
    const a = await E2eServer.start(w);
    cleanups.push(() => a.close());
    const broken = otherRepo("pg-e2e-broken-");
    const dotDir = path.join(broken, ".promptgraph");
    fs.mkdirSync(dotDir);
    fs.chmodSync(dotDir, 0o000);
    cleanups.push(() => fs.chmodSync(dotDir, 0o700));

    const summary = await a.api<RepoSummary>("POST", "/api/repos", { path: broken });
    expect(summary).toMatchObject({ active: false, error: expect.stringMatching(/EACCES|permission/i) });
    const write = await a.request("PUT", `/api/repos/${summary.id}/graphs/x`, chainGraph("x", [{ id: "s", type: "shell", config: { run: "true" } }]));
    expect(write.status).toBe(500);
    expect(await write.json()).toMatchObject({ code: "activation_failed" });

    await a.saveGraph(chainGraph("ok", [{ id: "s", type: "shell", config: { run: "echo fine" } }]));
    const run = (await a.startRun("ok")).run.id;
    expect((await a.waitForRun(run, ["succeeded", "failed", "paused"])).run.status).toBe("succeeded");
    const { repos } = await a.api<{ repos: RepoSummary[] }>("GET", "/api/repos");
    expect(repos.find((r) => r.id === a.repoId)).toMatchObject({ active: true, error: null });
    expect(repos.find((r) => r.id === summary.id)?.error).toBeTruthy();

    // Fixed: the next trigger retries the activation.
    fs.chmodSync(dotDir, 0o700);
    expect((await a.api<RepoSummary>("POST", "/api/repos", { path: broken })).error).toBeNull();
  });
});
