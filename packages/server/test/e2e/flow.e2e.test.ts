import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphInput, RunDetail } from "@promptgraph/shared";
import { waitFor } from "../helpers.js";
import { createWorld, E2eServer, readClaudeLog, type E2eWorld } from "./harness.js";

const SERVER_ROOT = path.resolve(import.meta.dirname, "../..");

/** Phase 2 end to end (§15): real shell + condition runners, fake claude, real git worktree. */
describe("e2e: control flow (fake claude)", () => {
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

  async function start(extraEnv?: Record<string, string>): Promise<{ w: E2eWorld; s: E2eServer }> {
    const w = world(extraEnv);
    return { w, s: await server(w) };
  }

  const node = (id: string, type: string, x: number, y: number, config: object, extra: object = {}) => ({
    id,
    type,
    label: id,
    position: { x, y },
    config,
    ...extra,
  });
  const graph = (id: string, nodes: object[], edges: object[]): GraphInput =>
    ({ version: 1, id, name: id, settings: { defaults: { completion: { mode: "auto", graceSec: 0 } } }, nodes, edges }) as GraphInput;

  /** [iteration, status] (or [iteration, attempt, status]) of every node run of a node, in order. */
  const runsOf = (detail: RunDetail, nodeId: string, withAttempt = false) =>
    detail.nodeRuns
      .filter((n) => n.nodeId === nodeId)
      .sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt)
      .map((n) => (withAttempt ? [n.iteration, n.attempt, n.status] : [n.iteration, n.status]));
  const summary = (detail: RunDetail) => detail.nodeRuns.map((n) => `${n.nodeId}#${n.iteration}.${n.attempt}:${n.status}:${n.error ?? ""}`).join(" ");
  const settle = (s: E2eServer, runId: string) => s.waitForRun(runId, ["succeeded", "failed", "paused", "cancelled"], 45_000);
  const expectValid = async (s: E2eServer, graphId: string) =>
    expect(await s.api<{ errors: unknown[] }>("POST", `/api/graphs/${graphId}/validate`, {})).toMatchObject({ errors: [] });
  /** The user message of the fake claude invocation whose argv mentions `needle` (nth match). */
  const claudeMessages = (w: E2eWorld, needle: string) =>
    readClaudeLog(w)
      .map((i) => i.argv)
      .filter((a) => a.some((x) => x.includes(needle)));
  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** implement → test (shell) ─always→ check (exit code) ─true→ done; ─false→ fix ⟲ test (max 2). */
  function testFixGraph(fixPrompt: string): GraphInput {
    return graph(
      "test-fix",
      [
        node("implement", "prompt", 0, 0, { prompt: "Implement it" }),
        node("test", "shell", 250, 0, { run: "test -f fixed.txt && echo PASS || { echo FAIL: fixed.txt missing; exit 1; }" }),
        node("check", "condition", 500, 0, { evaluator: { kind: "exitCode", equals: 0 } }),
        node("done", "shell", 750, 0, { run: "echo all good" }),
        node("fix", "prompt", 750, 150, { prompt: fixPrompt }),
      ],
      [
        { id: "e1", source: "implement", target: "test" },
        { id: "e2", source: "test", target: "check", when: "always" },
        { id: "e3", source: "check", sourcePort: "true", target: "done" },
        { id: "e4", source: "check", sourcePort: "false", target: "fix" },
        { id: "loop", source: "fix", target: "test", loop: { maxIterations: 2, onExhausted: "fail" } },
      ],
    );
  }

  /**
   * Canonical test-fix loop (§15.5): the test passes once it has seen two fixes (fixes.log lines), so the
   * body runs three times. `extra` nodes/edges hang off it.
   */
  function countingTestFix(opts: { max: number; onExhausted?: "fail" | "continue"; needed?: number; fix?: object; extraNodes?: object[]; extraEdges?: object[] }) {
    const needed = opts.needed ?? 2;
    return graph(
      "tf",
      [
        node("implement", "prompt", 0, 0, { prompt: "[[write:feature.txt:v1]] Implement the feature" }),
        node("test", "shell", 250, 0, { run: `n=$(cat fixes.log 2>/dev/null | wc -l); echo "fixes: $n"; test "$n" -ge ${needed} || { echo FAIL: not fixed yet; exit 1; }` }),
        node("check", "condition", 500, 0, { evaluator: { kind: "exitCode", equals: 0 } }),
        node("commit", "commit", 750, 0, { generateMessage: false, message: "feat: tested feature" }),
        node("fix", "prompt", 750, 200, { prompt: "[[bash:echo fix >> fixes.log]] Fix the failing tests", ...opts.fix }),
        ...(opts.extraNodes ?? []),
      ],
      [
        { id: "e1", source: "implement", target: "test" },
        { id: "e2", source: "test", target: "check", when: "always" },
        { id: "e3", source: "check", sourcePort: "true", target: "commit" },
        { id: "e4", source: "check", sourcePort: "false", target: "fix" },
        { id: "loop", source: "fix", target: "test", loop: { maxIterations: opts.max, onExhausted: opts.onExhausted ?? "fail" } },
        ...(opts.extraEdges ?? []),
      ],
    );
  }

  it("test-fix loop: the failing test output reaches the fix, the loop repeats once and the run succeeds", { timeout: 60_000 }, async () => {
    const { w, s } = await start();
    await s.saveGraph(testFixGraph("[[write:fixed.txt:ok]] Fix the failing test"));
    const ws = await s.connectWs();
    cleanups.push(() => ws.close());
    const validation = await s.api<{ errors: unknown[]; warnings: unknown[] }>("POST", "/api/graphs/test-fix/validate", {});
    expect(validation).toEqual({ errors: [], warnings: [] });

    const started = await s.startRun("test-fix");
    ws.subscribe(started.run.id);
    const done = await settle(s, started.run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");

    expect(runsOf(done, "test")).toEqual([[0, "failed"], [1, "succeeded"]]);
    expect(runsOf(done, "check")).toEqual([[0, "succeeded"], [1, "succeeded"]]);
    expect(runsOf(done, "fix")).toEqual([[0, "succeeded"], [1, "skipped"]]);
    expect(runsOf(done, "done")).toEqual([[0, "succeeded"]]);
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 1, maxIterations: 2, exhausted: false }]);
    expect(new Set(done.nodeRuns.map((n) => n.laneId))).toEqual(new Set(["main"]));

    // The fix session got the failed test and the condition result in its context block (fresh).
    const fixArgv = claudeMessages(w, "Fix the failing test")[0]!;
    const message = fixArgv.find((x) => x.includes("Fix the failing test"))!;
    expect(message).toContain("Condition result: false");
    expect(message).toContain("FAIL: fixed.txt missing");

    // New iterations reach subscribed clients as node:update of their pending node runs.
    expect(ws.nodeUpdates().some((nr) => nr.nodeId === "test" && nr.iteration === 1 && nr.status === "pending")).toBe(true);
  });

  it("test-fix loop: the test fails twice, the loop runs two extra iterations and the fixes are committed", { timeout: 60_000 }, async () => {
    const { w, s } = await start();
    await s.saveGraph(countingTestFix({ max: 3 }));
    await expectValid(s, "tf");
    const done = await settle(s, (await s.startRun("tf")).run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");

    expect(runsOf(done, "test")).toEqual([[0, "failed"], [1, "failed"], [2, "succeeded"]]);
    expect(runsOf(done, "check")).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "succeeded"]]);
    expect(done.nodeRuns.filter((n) => n.nodeId === "check").map((n) => n.output?.port)).toEqual(["false", "false", "true"]);
    expect(runsOf(done, "fix")).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "skipped"]]);
    expect(runsOf(done, "commit")).toEqual([[0, "succeeded"]]);
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 2, maxIterations: 3, exhausted: false }]);

    // The commit holds the implementation and both fixes.
    const sha = done.nodeRuns.find((n) => n.nodeId === "commit")!.output!.sha!;
    expect(gitIn(w.repo, "log", "-1", "--format=%s", sha)).toBe("feat: tested feature");
    expect(gitIn(w.repo, "show", "--name-only", "--format=", sha).split("\n").sort()).toEqual(["feature.txt", "fixes.log"]);
    expect(gitIn(w.repo, "show", `${sha}:fixes.log`)).toBe("fix\nfix");
  });

  it('test-fix loop exhausted with "fail": the loop source fails and the run pauses', { timeout: 60_000 }, async () => {
    const { s } = await start();
    await s.saveGraph(countingTestFix({ max: 1 }));
    const done = await settle(s, (await s.startRun("tf")).run.id);
    expect(done.run.status, summary(done)).toBe("paused");
    expect(runsOf(done, "test")).toEqual([[0, "failed"], [1, "failed"]]);
    expect(runsOf(done, "fix")).toEqual([[0, "succeeded"], [1, "failed"]]);
    const lastFix = done.nodeRuns.filter((n) => n.nodeId === "fix").at(-1)!;
    expect(lastFix.error).toBe('Loop back to "test" exhausted (looped back 1 of 1 time)');
    expect(lastFix.output?.text).toMatch(/^Done: /); // the work is kept
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 1, maxIterations: 1, exhausted: true }]);
    expect(runsOf(done, "commit")).toEqual([[0, "pending"]]);
  });

  it('test-fix loop exhausted with "continue": the loop edge delivers a skip and the flow goes on', { timeout: 60_000 }, async () => {
    const { s } = await start();
    await s.saveGraph(
      countingTestFix({
        max: 1,
        onExhausted: "continue",
        extraNodes: [node("report", "shell", 1000, 200, { run: "echo giving up after $(cat fixes.log | wc -l) fixes" })],
        extraEdges: [{ id: "e5", source: "fix", target: "report" }],
      }),
    );
    await expectValid(s, "tf");
    const done = await settle(s, (await s.startRun("tf")).run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");
    expect(runsOf(done, "fix")).toEqual([[0, "succeeded"], [1, "succeeded"]]);
    expect(runsOf(done, "commit")).toEqual([[0, "skipped"]]);
    // The exit after the loop runs once, after the last pass.
    expect(runsOf(done, "report")).toEqual([[0, "succeeded"]]);
    expect(done.nodeRuns.find((n) => n.nodeId === "report")!.output?.stdoutTail).toContain("giving up after 2 fixes");
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 1, maxIterations: 1, exhausted: true }]);
  });

  it("review loop: a judge condition sends the review back once, then the flow simplifies and commits", { timeout: 60_000 }, async () => {
    const w = world();
    const judgeScript = path.join(w.root, "judge-answers.txt");
    fs.writeFileSync(judgeScript, "true\nfalse\n");
    w.env.FAKE_CLAUDE_JUDGE_SCRIPT = judgeScript;
    const s = await server(w);
    await s.saveGraph(
      graph(
        "review",
        [
          node("implement", "prompt", 0, 0, { prompt: "[[write:feature.txt:v1]] Implement the feature" }),
          node("review", "command", 250, 0, { command: "/code-review" }),
          node("blocking", "condition", 500, 0, { evaluator: { kind: "judge", question: "Did the review report any blocking issue?" } }),
          node("address", "prompt", 750, 200, { prompt: "[[write:feature.txt:v2]] Address the review findings" }),
          node("simplify", "command", 750, 0, { command: "/simplify" }),
          node("commit", "commit", 1000, 0, { generateMessage: false, message: "feat: reviewed feature" }),
        ],
        [
          { id: "e1", source: "implement", target: "review" },
          { id: "e2", source: "review", target: "blocking" },
          { id: "e3", source: "blocking", sourcePort: "true", target: "address" },
          { id: "e4", source: "blocking", sourcePort: "false", target: "simplify" },
          { id: "e5", source: "simplify", target: "commit" },
          { id: "loop", source: "address", target: "review", loop: { maxIterations: 2, onExhausted: "fail" } },
        ],
      ),
    );
    await expectValid(s, "review");
    const done = await settle(s, (await s.startRun("review")).run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");

    expect(runsOf(done, "review")).toEqual([[0, "succeeded"], [1, "succeeded"]]);
    const verdicts = done.nodeRuns.filter((n) => n.nodeId === "blocking").map((n) => [n.output?.port, n.output?.result]);
    expect(verdicts).toEqual([["true", true], ["false", false]]);
    expect(runsOf(done, "address")).toEqual([[0, "succeeded"], [1, "skipped"]]);
    expect(runsOf(done, "simplify")).toEqual([[0, "succeeded"]]);
    expect(runsOf(done, "commit")).toEqual([[0, "succeeded"]]);
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 1, maxIterations: 2, exhausted: false }]);
    expect(fs.readFileSync(judgeScript, "utf8")).toBe(""); // both scripted answers consumed

    // The address session saw the judge verdict and its reason (slash commands run as typed).
    const address = claudeMessages(w, "Address the review findings")[0]!.find((x) => x.includes("Address the review findings"))!;
    expect(address).toContain("Condition result: true");
    expect(address).toContain("fake reason");
    expect(claudeMessages(w, "/code-review")).toHaveLength(2);
  });

  it("failure routing: a failing build goes through its error port to a fix and is built again; the run never pauses", { timeout: 60_000 }, async () => {
    const { w, s } = await start();
    const build = "sleep 0.3; test -f built.ok && echo BUILD OK || { echo 'error TS2304: Cannot find name foo'; exit 2; }";
    await s.saveGraph(
      graph(
        "failroute",
        [
          node("build", "shell", 0, 0, { run: build }),
          node("fix", "prompt", 250, 150, { prompt: "[[write:built.ok:1]] Fix the build error" }),
          node("rebuild", "shell", 500, 150, { run: build }),
          node("ship", "shell", 250, 0, { run: "echo shipping" }),
        ],
        [
          { id: "err", source: "build", sourcePort: "error", target: "fix", when: "failure" },
          { id: "e2", source: "fix", target: "rebuild" },
          { id: "e3", source: "build", target: "ship" },
        ],
      ),
    );
    await expectValid(s, "failroute");
    const ws = await s.connectWs();
    cleanups.push(() => ws.close());
    const started = await s.startRun("failroute");
    ws.subscribe(started.run.id);
    const done = await settle(s, started.run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");
    expect(runsOf(done, "build")).toEqual([[0, "failed"]]);
    expect(done.nodeRuns.find((n) => n.nodeId === "build")!.output?.exitCode).toBe(2);
    expect(runsOf(done, "fix")).toEqual([[0, "succeeded"]]);
    expect(runsOf(done, "rebuild")).toEqual([[0, "succeeded"]]);
    expect(runsOf(done, "ship")).toEqual([[0, "skipped"]]);

    const statuses = ws.messages.flatMap((m) => (m.type === "run:update" && m.run.id === started.run.id ? [m.run.status] : []));
    expect(statuses).not.toContain("paused");
    // The fix got the failing build's output in its context.
    const fix = claudeMessages(w, "Fix the build error")[0]!.find((x) => x.includes("Fix the build error"))!;
    expect(fix).toContain("error TS2304: Cannot find name foo");
  });

  it("if/else re-joins into one node; the dead branch is skipped transitively and left out of the join's context", { timeout: 60_000 }, async () => {
    const { w, s } = await start();
    await s.saveGraph(
      graph(
        "ifelse",
        [
          node("probe", "shell", 0, 0, { run: "echo 'mode: fast'" }),
          node("isFast", "condition", 250, 0, { evaluator: { kind: "regex", pattern: "^mode: FAST$", flags: "im" } }),
          node("fast", "shell", 500, 0, { run: "echo took the fast path" }),
          node("slow", "shell", 500, 200, { run: "echo took the slow path" }),
          node("slower", "shell", 750, 200, { run: "echo still slow" }),
          node("join", "prompt", 1000, 0, { prompt: "Summarize the path taken" }),
        ],
        [
          { id: "e1", source: "probe", target: "isFast" },
          { id: "t", source: "isFast", sourcePort: "true", target: "fast" },
          { id: "f", source: "isFast", sourcePort: "false", target: "slow" },
          { id: "e2", source: "slow", target: "slower" },
          { id: "j1", source: "fast", target: "join" },
          { id: "j2", source: "slower", target: "join" },
        ],
      ),
    );
    await expectValid(s, "ifelse");
    const done = await settle(s, (await s.startRun("ifelse")).run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");
    expect(Object.fromEntries(done.nodeRuns.map((n) => [n.nodeId, n.status]))).toEqual({
      probe: "succeeded",
      isFast: "succeeded",
      fast: "succeeded",
      slow: "skipped",
      slower: "skipped",
      join: "succeeded",
    });
    expect(done.nodeRuns.find((n) => n.nodeId === "isFast")!.output).toMatchObject({ port: "true", result: true });
    expect(done.lanes.map((l) => l.id)).toEqual(["main"]);
    const join = claudeMessages(w, "Summarize the path taken");
    expect(join).toHaveLength(1);
    const message = join[0]!.find((x) => x.includes("Summarize the path taken"))!;
    expect(message).toContain("took the fast path");
    expect(message).not.toContain("still slow");
  });

  it("retry inside a loop iteration: an unhandled failure pauses, retry re-runs the same iteration and the loop goes on", { timeout: 60_000 }, async () => {
    const { s } = await start();
    // fix → verify ⟲ test; verify fails on the second pass until retry.ok exists.
    const g = countingTestFix({
      max: 3,
      needed: 3,
      extraNodes: [node("verify", "shell", 1000, 200, { run: 'n=$(cat fixes.log | wc -l); test "$n" -ne 2 || test -f retry.ok' })],
      extraEdges: [{ id: "e5", source: "fix", target: "verify" }],
    });
    g.edges = g.edges!.map((e) => (e.id === "loop" ? { ...e, source: "verify" } : e));
    await s.saveGraph(g);
    await expectValid(s, "tf");

    const runId = (await s.startRun("tf")).run.id;
    const paused = await settle(s, runId);
    expect(paused.run.status, summary(paused)).toBe("paused");
    const failed = paused.nodeRuns.find((n) => n.nodeId === "verify" && n.status === "failed")!;
    expect(failed).toMatchObject({ iteration: 1, attempt: 0 });

    fs.writeFileSync(path.join(paused.lanes[0]!.worktreePath, "retry.ok"), "");
    const { nodeRun: retried } = await s.api<{ nodeRun: { iteration: number; attempt: number } }>("POST", `/api/node-runs/${failed.id}/retry`);
    expect(retried).toMatchObject({ iteration: 1, attempt: 1 });
    const done = await settle(s, runId);
    expect(done.run.status, summary(done)).toBe("succeeded");
    expect(runsOf(done, "verify", true)).toEqual([
      [0, 0, "succeeded"],
      [1, 0, "failed"],
      [1, 1, "succeeded"],
      [2, 0, "succeeded"],
      [3, 0, "skipped"],
    ]);
    expect(runsOf(done, "test")).toEqual([[0, "failed"], [1, "failed"], [2, "failed"], [3, "succeeded"]]);
    expect(runsOf(done, "commit")).toEqual([[0, "succeeded"]]);
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 3, maxIterations: 3, exhausted: false }]);
  });

  it("context resume: the fix continues its own Claude session across loop iterations", { timeout: 60_000 }, async () => {
    const { w, s } = await start();
    await s.saveGraph(countingTestFix({ max: 3, fix: { context: "resume" } }));
    await expectValid(s, "tf");
    const done = await settle(s, (await s.startRun("tf")).run.id);
    expect(done.run.status, summary(done)).toBe("succeeded");
    const fixes = done.nodeRuns.filter((n) => n.nodeId === "fix" && n.status === "succeeded");
    expect(fixes.map((n) => n.iteration)).toEqual([0, 1]);
    expect(fixes[0]!.sessionId).toBeTruthy();

    const invocations = claudeMessages(w, "Fix the failing tests");
    expect(invocations).toHaveLength(2);
    // First pass: a new session with the context block (the failing test via the condition).
    expect(invocations[0]).not.toContain("--resume");
    expect(invocations[0]!.join(" ")).toContain("FAIL: not fixed yet");
    // Second pass: the same session, resumed, with this iteration's context block (the new failing output).
    expect(invocations[1]).toContain("--resume");
    expect(invocations[1]).toContain(fixes[0]!.sessionId);
    expect(invocations[1]!.join(" ")).toContain("Context from previous steps");
    expect(invocations[1]!.join(" ")).toContain("FAIL: not fixed yet");
  });

  it("crash recovery mid-loop: the interrupted iteration resumes and the loop finishes", { timeout: 90_000 }, async () => {
    const w = world();
    const graphsDir = path.join(w.repo, ".promptgraph", "graphs");
    fs.mkdirSync(graphsDir, { recursive: true });
    // The second test run prints [[hang]]: the fix of iteration 1 then hangs (its context holds the marker).
    const g = countingTestFix({ max: 3 });
    g.nodes = g.nodes!.map((n) =>
      n.id === "test" ? { ...n, config: { run: "test -f ok.txt && exit 0; test -f fixes.log && echo '[[hang]]'; echo FAIL; exit 1" } } : n,
    ) as GraphInput["nodes"];
    fs.writeFileSync(path.join(graphsDir, "tf.json"), JSON.stringify(g));

    // First server: a separate process we can SIGKILL mid-loop (tsx as an in-process loader, see run.e2e).
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
    const runId = ((await (await fetch(`${base}/api/graphs/tf/runs`, { method: "POST", headers: auth })).json()) as { run: { id: string } }).run.id;
    const read = async () => (await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json()) as RunDetail;
    const end = Date.now() + 30_000;
    let before = await read();
    const hanging = () => before.nodeRuns.find((n) => n.nodeId === "fix" && n.iteration === 1 && n.status === "running" && n.sessionId);
    while (!hanging() && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      before = await read();
    }
    expect(hanging(), summary(before)).toBeTruthy();
    const sessionId = hanging()!.sessionId!;
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    // Second server on the same PG_HOME: the iteration-1 fix is interrupted, the run paused, counters kept.
    const s = await server(w);
    const recovered = await s.getRun(runId);
    expect(recovered.run.status).toBe("paused");
    expect(runsOf(recovered, "fix")).toEqual([[0, "succeeded"], [1, "interrupted"]]);
    expect(runsOf(recovered, "test")).toEqual([[0, "failed"], [1, "failed"]]);
    expect(recovered.loops).toEqual([{ edgeId: "loop", iteration: 1, maxIterations: 3, exhausted: false }]);

    fs.writeFileSync(path.join(recovered.lanes[0]!.worktreePath, "ok.txt"), "");
    const interrupted = recovered.nodeRuns.find((n) => n.status === "interrupted")!;
    await s.api("POST", `/api/node-runs/${interrupted.id}/retry`);
    const done = await settle(s, runId);
    expect(done.run.status, summary(done)).toBe("succeeded");
    expect(runsOf(done, "fix", true)).toEqual([
      [0, 0, "succeeded"],
      [1, 0, "interrupted"],
      [1, 1, "succeeded"],
      [2, 0, "skipped"],
    ]);
    expect(runsOf(done, "test")).toEqual([[0, "failed"], [1, "failed"], [2, "succeeded"]]);
    expect(runsOf(done, "commit")).toEqual([[0, "succeeded"]]);
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 2, maxIterations: 3, exhausted: false }]);
    const resumed = readClaudeLog(w).at(-1)!;
    expect(resumed.argv).toContain("--resume");
    expect(resumed.argv).toContain(sessionId);
  });
});
