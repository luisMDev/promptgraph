import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/cli/server.js";
import { createTempRepo } from "../helpers.js";
import { chainGraph, createWorld, E2eServer, type E2eWorld } from "./harness.js";

/** Several promptgraph instances share one PG_HOME (one state.db): each only touches its own runs. */
describe("e2e: instances sharing a state DB", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function world(): E2eWorld {
    const w = createWorld();
    cleanups.push(() => w.cleanup());
    return w;
  }

  it("a second instance (busy port, same repo, other repo) never interrupts the first one's runs", { timeout: 30_000 }, async () => {
    const w = world();
    const a = await E2eServer.start(w);
    cleanups.push(() => a.close());
    await a.saveGraph(chainGraph("slow", [{ id: "wait", type: "shell", config: { run: "sleep 1.5; echo done" } }]));
    const runId = (await a.startRun("slow")).run.id;
    await a.waitForNode(runId, "wait", ["running"]);

    // Same repository: refused before touching the DB.
    await expect(startServer({ repoPath: w.repo, port: 0, env: w.env })).rejects.toThrow("already running");

    // Another repository, A's port: fails on the port before recovery.
    const other = createTempRepo("pg-e2e-other-");
    cleanups.push(other.cleanup);
    await expect(startServer({ repoPath: other.repo, port: a.server.port, env: w.env })).rejects.toThrow("already in use");
    expect((await a.getRun(runId)).run.status).toBe("running");

    // Another repository started and stopped meanwhile: neither recovery nor shutdown touches A's run.
    const b = await startServer({ repoPath: other.repo, port: 0, env: w.env });
    await b.close();
    expect((await a.getRun(runId)).run.status).toBe("running");
    expect((await a.nodeRun(runId, "wait")).status).toBe("running");

    // B cannot see A's runs either.
    const b2 = await startServer({ repoPath: other.repo, port: 0, env: w.env });
    cleanups.push(() => b2.close());
    const res = await fetch(`http://127.0.0.1:${b2.port}/api/runs/${runId}`, { headers: { authorization: `Bearer ${b2.token}` } });
    expect(res.status).toBe(404);

    const done = await a.waitForRun(runId, ["succeeded", "failed", "paused"]);
    expect(done.run.status).toBe("succeeded");
  });
});
