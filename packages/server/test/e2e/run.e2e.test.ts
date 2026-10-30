import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ptyLogPath } from "../../src/config/paths.js";
import { openDatabase, Store } from "../../src/store/store.js";
import { waitFor } from "../helpers.js";
import { chainGraph, createWorld, E2eServer, readClaudeLog, until, type E2eWorld } from "./harness.js";

const SERVER_ROOT = path.resolve(import.meta.dirname, "../..");

describe("e2e: real server, fake claude", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function world(extraEnv?: Record<string, string>): E2eWorld {
    const w = createWorld(extraEnv);
    cleanups.push(() => w.cleanup());
    return w;
  }

  async function server(w: E2eWorld): Promise<E2eServer> {
    const s = await E2eServer.start(w);
    cleanups.push(() => s.close());
    return s;
  }

  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("runs prompt → shell → command → commit in one lane", { timeout: 60_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(
      chainGraph("linear", [
        { id: "write", type: "prompt", config: { prompt: "[[write:notes.txt:hello from claude]] Write the notes" } },
        { id: "check", type: "shell", config: { run: "cat notes.txt && echo && echo shell-ok" } },
        { id: "review", type: "command", config: { command: "/review" } },
        { id: "save", type: "commit", config: { generateMessage: false, message: "e2e: add notes" } },
      ]),
    );
    const ws = await s.connectWs();
    cleanups.push(() => ws.close());

    const started = await s.startRun("linear");
    const runId = started.run.id;
    ws.subscribe(runId);
    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");

    const byNode = new Map(done.nodeRuns.map((nr) => [nr.nodeId, nr]));
    for (const id of ["write", "check", "review", "save"]) expect(byNode.get(id)?.status, id).toBe("succeeded");
    expect(byNode.get("write")!.output?.text).toBe("Done: Write the notes");
    expect(byNode.get("write")!.output?.usage?.outputTokens).toBeGreaterThan(0);
    expect(byNode.get("check")!.output).toMatchObject({ exitCode: 0 });
    expect(byNode.get("check")!.output?.stdoutTail).toContain("hello from claude");
    expect(byNode.get("check")!.output?.stdoutTail).toContain("shell-ok");
    expect(byNode.get("review")!.output?.text).toBe("Ran /review");
    expect(done.run.usage.outputTokens).toBe(68);
    expect(done.run.usage.costUsd).toBeGreaterThan(0);

    // Live status stream over WS: the last node goes through running to succeeded.
    const saveRun = byNode.get("save")!;
    await waitFor(() => ws.nodeUpdates(saveRun.id).some((nr) => nr.status === "succeeded"));
    expect(ws.nodeUpdates(saveRun.id).map((nr) => nr.status)).toContain("running");

    // Replay of a finished terminal from its flushed log.
    const promptPty = byNode.get("write")!.ptyId!;
    expect(promptPty).toBe(byNode.get("write")!.id);
    ws.attach(promptPty);
    await ws.waitFor((m) => m.type === "pty:attached" && m.ptyId === promptPty && !m.live);
    await waitFor(() => ws.ptyText(promptPty).includes("Done: Write the notes"));
    for (const id of ["write", "check", "review"]) {
      const log = ptyLogPath(s.server.ctx.paths, runId, byNode.get(id)!.id);
      expect(fs.statSync(log).size, id).toBeGreaterThan(0);
    }

    // Commit landed on the lane branch; the worktree was cleaned up (success + keep on-failure) but the
    // branch with its commit survives.
    const lane = done.lanes[0]!;
    expect(done.lanes).toHaveLength(1);
    expect(lane.branch).toBe(`pg/linear/${done.run.shortId}/main`);
    expect(gitIn(w.repo, "log", "-1", "--format=%s", lane.branch)).toBe("e2e: add notes");
    expect(gitIn(w.repo, "show", `${lane.branch}:notes.txt`)).toBe("hello from claude");
    expect(byNode.get("save")!.output?.sha).toBe(gitIn(w.repo, "rev-parse", lane.branch));
    // Cleanup runs right after the run is marked succeeded.
    await until(async () => (await s.getRun(runId)).run.cleanedUp);
    expect(fs.existsSync(lane.worktreePath)).toBe(false);
    // The main checkout is untouched apart from the graph file itself.
    expect(gitIn(w.repo, "status", "--porcelain")).toBe("?? .promptgraph/");

    // Persisted: a second connection to the DB sees the same node runs.
    const db = openDatabase(s.server.ctx.paths.stateDb);
    try {
      const stored = new Store(db).listNodeRuns(runId);
      expect(stored.map((nr) => `${nr.nodeId}:${nr.status}`).sort()).toEqual(
        ["check:succeeded", "review:succeeded", "save:succeeded", "write:succeeded"],
      );
    } finally {
      db.close();
    }

    // The child env of claude is stripped (SPIKE) and carries the hook variables.
    const calls = readClaudeLog(w).filter((c) => !c.argv.includes("-p"));
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.env.CLAUDECODE).toBeUndefined();
      expect(c.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(c.env.PG_NODE_RUN_ID).toBeTruthy();
      expect(c.cwd).toBe(lane.worktreePath);
    }
  });

  it("manual completion waits for Done and passes the output to the next prompt", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(
      chainGraph("manual", [
        { id: "first", type: "prompt", config: { prompt: "[[reply:ALPHA-123]] say it", completion: { mode: "manual" } } },
        { id: "second", type: "prompt", config: { prompt: "Use the previous answer", context: "fresh" } },
      ]),
    );
    const { run } = await s.startRun("manual");
    const first = await s.waitForNode(run.id, "first", ["idle"]);
    expect(first.output?.text).toBe("ALPHA-123");
    expect((await s.nodeRun(run.id, "second")).status).toBe("pending");

    await s.api("POST", `/api/node-runs/${first.id}/done`);
    const done = await s.waitForRun(run.id, ["succeeded", "failed", "paused"]);
    expect(done.run.status).toBe("succeeded");

    const secondCall = readClaudeLog(w).find((c) => c.argv.some((a) => a.includes("Use the previous answer")))!;
    const message = secondCall.argv.find((a) => a.includes("Use the previous answer"))!;
    expect(message).toContain("Context from previous steps");
    expect(message).toContain("### first (prompt, succeeded)\nALPHA-123");
  });

  it("a context=resume chain reports each node's own usage and a run total without double counting", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(
      chainGraph("resume", [
        { id: "a", type: "prompt", config: { prompt: "[[reply:ALPHA]] remember" } },
        { id: "b", type: "prompt", config: { prompt: "[[recall]] what was it?", context: "resume" } },
      ]),
    );
    const { run } = await s.startRun("resume");
    const done = await s.waitForRun(run.id, ["succeeded", "failed", "paused"]);
    expect(done.run.status).toBe("succeeded");
    const byNode = new Map(done.nodeRuns.map((nr) => [nr.nodeId, nr]));
    expect(byNode.get("b")!.sessionId).toBe(byNode.get("a")!.sessionId);
    expect(byNode.get("b")!.output?.text).toBe("ALPHA");
    expect(byNode.get("a")!.output?.usage?.outputTokens).toBe(34);
    expect(byNode.get("b")!.output?.usage?.outputTokens).toBe(34);
    expect(done.run.usage.outputTokens).toBe(68);
  });

  it("marker mode completes only when the reply ends with the token", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(
      chainGraph("marker", [{ id: "m", type: "prompt", config: { prompt: "[[reply:first turn]] Start working", completion: { mode: "marker", token: "PGDONE" } } }]),
    );
    const ws = await s.connectWs();
    cleanups.push(() => ws.close());
    const { run } = await s.startRun("marker");
    const nr = await s.waitForNode(run.id, "m", ["idle"]);
    expect(nr.output?.text).toBe("first turn");

    ws.attach(nr.id);
    await ws.waitFor((m) => m.type === "pty:attached" && m.ptyId === nr.id && m.live);
    ws.input(nr.id, "[[marker:PGDONE]] finish now\r");
    const done = await s.waitForRun(run.id, ["succeeded", "failed", "paused"]);
    expect(done.run.status).toBe("succeeded");
    expect(done.nodeRuns[0]!.output?.text).toBe("Done: finish now\nPGDONE");
  });

  it("waiting_input on a permission prompt, answered by typing in the terminal", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(chainGraph("ask", [{ id: "a", type: "prompt", config: { prompt: "[[ask:May I edit?]] edit things" } }]));
    const ws = await s.connectWs();
    cleanups.push(() => ws.close());
    const { run } = await s.startRun("ask");
    ws.subscribe(run.id);

    const waiting = await s.waitForNode(run.id, "a", ["waiting_input"]);
    expect(waiting.waitingReason).toMatchObject({ kind: "notification", notificationType: "permission_prompt", message: "May I edit?" });
    expect((await s.getRun(run.id)).run.waitingInput).toBe(1);

    ws.attach(waiting.id);
    await ws.waitFor((m) => m.type === "pty:attached" && m.ptyId === waiting.id && m.live);
    await waitFor(() => ws.ptyText(waiting.id).includes("May I edit?"));
    ws.input(waiting.id, "yes\r");

    const done = await s.waitForRun(run.id, ["succeeded", "failed", "paused"]);
    expect(done.run.status).toBe("succeeded");
    expect(done.nodeRuns[0]!.output?.text).toBe("Done: edit things (answer: yes)");
    const statuses = ws.nodeUpdates(waiting.id).map((nr) => nr.status);
    expect(statuses.indexOf("running", statuses.indexOf("waiting_input"))).toBeGreaterThan(-1);
  });

  it("a failing shell pauses the run; retry resumes it", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(
      chainGraph("retry", [
        { id: "gate", type: "shell", config: { run: "test -f ok.flag" } },
        { id: "after", type: "shell", config: { run: "echo after" } },
      ]),
    );
    const { run } = await s.startRun("retry");
    const paused = await s.waitForRun(run.id, ["paused", "failed", "succeeded"]);
    expect(paused.run.status).toBe("paused");
    const gate = paused.nodeRuns.find((n) => n.nodeId === "gate")!;
    expect(gate).toMatchObject({ status: "failed", output: { exitCode: 1 } });
    expect(paused.nodeRuns.find((n) => n.nodeId === "after")!.status).toBe("pending");

    fs.writeFileSync(path.join(paused.lanes[0]!.worktreePath, "ok.flag"), "");
    const { nodeRun: retried } = await s.api<{ nodeRun: { id: string; attempt: number } }>("POST", `/api/node-runs/${gate.id}/retry`);
    expect(retried.attempt).toBe(1);
    const done = await s.waitForRun(run.id, ["succeeded", "failed", "paused"]);
    expect(done.run.status).toBe("succeeded");
    expect(done.nodeRuns.filter((n) => n.nodeId === "gate").map((n) => n.status)).toEqual(["failed", "succeeded"]);
  });

  it("a failing shell can be skipped", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(
      chainGraph("skip", [
        { id: "gate", type: "shell", config: { run: "exit 3" } },
        { id: "after", type: "shell", config: { run: "echo after" } },
      ]),
    );
    const { run } = await s.startRun("skip");
    const paused = await s.waitForRun(run.id, ["paused", "failed", "succeeded"]);
    expect(paused.run.status).toBe("paused");
    const gate = paused.nodeRuns.find((n) => n.nodeId === "gate")!;
    expect(gate.output?.exitCode).toBe(3);
    await s.api("POST", `/api/node-runs/${gate.id}/skip`);
    const done = await s.waitForRun(run.id, ["succeeded", "failed"]);
    expect(done.run.status).toBe("succeeded");
    expect(done.nodeRuns.map((n) => `${n.nodeId}:${n.status}`).sort()).toEqual(["after:succeeded", "gate:skipped"]);
  });

  it("cancel stops the live Claude session", { timeout: 40_000 }, async () => {
    const w = world();
    const s = await server(w);
    await s.saveGraph(chainGraph("cancel", [{ id: "h", type: "prompt", config: { prompt: "[[hang]] never ends" } }]));
    const { run } = await s.startRun("cancel");
    const nr = await s.waitForNode(run.id, "h", ["running"]);
    await waitFor(() => s.server.ctx.ptys.get(nr.id)?.isLive);
    await s.api("POST", `/api/runs/${run.id}/cancel`);
    const done = await s.waitForRun(run.id, ["cancelled"]);
    expect(done.nodeRuns[0]!.status).toBe("cancelled");
    await waitFor(() => s.server.ctx.ptys.get(nr.id)?.isLive === false);
  });

  it("recovers after a server crash: the node is interrupted and its retry resumes the session", { timeout: 60_000 }, async () => {
    const w = world();
    const graphsDir = path.join(w.repo, ".promptgraph", "graphs");
    fs.mkdirSync(graphsDir, { recursive: true });
    const graph = chainGraph("crash", [{ id: "h", type: "prompt", config: { prompt: "[[hang]] long task" } }]);
    fs.writeFileSync(path.join(graphsDir, "crash.json"), JSON.stringify(graph));

    // First server: a separate process we can SIGKILL mid-run.
    // tsx as an in-process loader (not its CLI wrapper), so SIGKILL hits the server process itself.
    const child = spawn(process.execPath, ["--import", "tsx", "--conditions=source", "src/cli/index.ts", w.repo, "--port", "0", "--no-open"], {
      cwd: SERVER_ROOT,
      env: w.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => void child.kill("SIGKILL"));
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    const url = new URL(await waitFor(() => /Open: (\S+)/.exec(stdout)?.[1], 20_000));
    const base = `${url.protocol}//${url.host}`;
    const auth = { authorization: `Bearer ${url.searchParams.get("t")}` };
    const started = (await (await fetch(`${base}/api/graphs/crash/runs`, { method: "POST", headers: auth })).json()) as {
      run: { id: string };
    };
    const runId = started.run.id;
    const readNode = async () =>
      ((await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json()) as { nodeRuns: { status: string; sessionId: string | null }[] })
        .nodeRuns[0]!;
    let before = await readNode();
    const end = Date.now() + 15_000;
    while (!(before.status === "running" && before.sessionId) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      before = await readNode();
    }
    expect(before.status).toBe("running");
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    // Second server on the same PG_HOME: recovery marks it interrupted and pauses the run.
    const s = await server(w);
    const recovered = await s.getRun(runId);
    expect(recovered.run.status).toBe("paused");
    const interrupted = recovered.nodeRuns[0]!;
    expect(interrupted.status).toBe("interrupted");

    await s.api("POST", `/api/node-runs/${interrupted.id}/retry`);
    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 30_000);
    expect(done.run.status).toBe("succeeded");
    const resumed = readClaudeLog(w).at(-1)!;
    expect(resumed.argv).toContain("--resume");
    expect(resumed.argv).toContain(before.sessionId);
    expect(done.nodeRuns.at(-1)!.output?.text).toBe("Done: You were interrupted. Continue the task.");
  });
});
