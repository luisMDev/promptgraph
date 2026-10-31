import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphInput, NodeRun } from "@promptgraph/shared";
import { getPaths, hooksSettingsPath, ptyLogPath } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { HookRouter } from "../src/hooks/hook-router.js";
import { hookToken } from "../src/hooks/hook-token.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import { buildClaudeArgs } from "../src/runners/claude/args.js";
import { INTERRUPTED_MESSAGE } from "../src/runners/claude/context.js";
import { installPgHook } from "../src/runners/claude/pg-hook.js";
import type { RunnerResult } from "../src/runners/types.js";
import { fakeClaudeEnv, tempDir, waitFor } from "./helpers.js";
import { makeCtx, makeLane, makeNodeRun, makeRun, type TestContext } from "./support/runner-ctx.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TOKEN = "test-token";

async function setup(extraEnv: Record<string, string> = {}) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const fakeLog = path.join(t.dir, "fake-claude.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...fakeClaudeEnv(t.dir),
    FAKE_CLAUDE_LOG: fakeLog,
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    SOME_HERMETIC_FLAG: "1",
    ...extraEnv,
  };
  const paths = getPaths(env);
  const bus = new EventBus();
  const ptys = new PtyManager(bus, () => null);
  cleanups.push(() => ptys.killAll());
  const hooks = new HookRouter();
  const pgHookPath = installPgHook(paths);
  const hookCalls: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
      if (!m || req.headers.authorization !== `Bearer ${hookToken(TOKEN, m[1]!)}`) {
        res.writeHead(401).end();
        return;
      }
      hookCalls.push(m[2]!);
      hooks.dispatch(m[1]!, m[2]!, JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const runner = new ClaudeRunner({ ptys, hooks, paths, pgHookPath, endpoint: () => ({ port, token: TOKEN }), env });
  const worktree = path.join(t.dir, "worktree");
  fs.mkdirSync(worktree);
  const invocations = () =>
    fs.existsSync(fakeLog)
      ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string>; cwd: string })
      : [];
  return { dir: t.dir, env, paths, ptys, hooks, runner, worktree, invocations, hookCalls };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function start(
  s: Setup,
  config: Record<string, unknown>,
  opts: { type?: "prompt" | "command"; settings?: GraphInput["settings"]; id?: string; predecessors?: TestContext["predecessors"]; previousAttempt?: NodeRun; previousIteration?: NodeRun } = {},
) {
  const nodeId = opts.id ?? "n1";
  const run = makeRun({ settings: opts.settings, nodes: [{ id: nodeId, type: opts.type ?? "prompt", label: "Build", config } as never] });
  const ctx = makeCtx({
    run,
    node: run.graphSnapshot.nodes[0]!,
    lane: makeLane(s.worktree),
    nodeRunId: `nr-${nodeId}`,
    predecessors: opts.predecessors,
    previousAttempt: opts.previousAttempt,
    previousIteration: opts.previousIteration,
    inLoopBody: opts.previousIteration !== undefined,
  });
  const exec = s.runner.start(ctx);
  let settled: RunnerResult | null = null;
  void exec.result.then((r) => (settled = r));
  return { ctx, exec, run, settled: () => settled };
}

const auto0 = { mode: "auto", graceSec: 0 };

describe("ClaudeRunner (fake claude)", () => {
  it("runs a prompt to success: args, env stripping, pre-trust, hooks, output, usage, log", async () => {
    const s = await setup();
    const { ctx, exec, run } = start(s, { prompt: "build it [[write:out.txt:hello]]", completion: auto0, model: "sonnet" });
    const result = await exec.result;
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.text).toBe("Done: build it");
    expect(result.output.usage).toMatchObject({ inputTokens: 12, outputTokens: 34, cacheCreationTokens: 1000, cacheReadTokens: 2000, model: "claude-sonnet-5-5" });
    expect(result.output.usage!.costUsd).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(s.worktree, "out.txt"), "utf8")).toBe("hello");

    const [inv] = s.invocations();
    expect(inv!.cwd).toBe(s.worktree);
    expect(inv!.argv[0]).toBe("build it [[write:out.txt:hello]]");
    const sid = inv!.argv[inv!.argv.indexOf("--session-id") + 1];
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(inv!.argv).toEqual(expect.arrayContaining(["--name", "pg:g1/Build", "--settings", hooksSettingsPath(s.paths, run.id), "--permission-mode", "acceptEdits", "--model", "sonnet"]));
    expect(inv!.env).toMatchObject({ PG_NODE_RUN_ID: "nr-n1", TERM: "xterm-256color" });
    // The session token never reaches Claude: hooks authenticate with a per-node-run header file.
    expect(inv!.env.PG_TOKEN).toBeUndefined();
    expect(Object.values(inv!.env)).not.toContain(TOKEN);
    expect(inv!.env.PG_HOOK_HEADER_FILE).toMatch(/hook-nr-n1\.header$/);
    expect(inv!.env.CLAUDECODE).toBeUndefined();
    expect(inv!.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(inv!.env.SOME_HERMETIC_FLAG).toBeUndefined();

    const cfg = JSON.parse(fs.readFileSync(path.join(s.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"));
    expect(cfg.projects[s.worktree].hasTrustDialogAccepted).toBe(true);

    expect(ctx.patches[0]).toEqual({ ptyId: "nr-n1", sessionId: sid });
    expect(ctx.current).toMatchObject({ sessionId: sid, activity: `Write: ${path.join(s.worktree, "out.txt")}` });
    expect(ctx.current.transcriptPath).toContain(`${sid}.jsonl`);
    expect(s.hookCalls).toEqual(["session-start", "activity", "stop"]);
    const log = fs.readFileSync(ptyLogPath(s.paths, run.id, "nr-n1"), "utf8");
    expect(log).toContain("Fake Claude Code");
    expect(log).toContain("Goodbye!");
  });

  it("command nodes send the slash command", async () => {
    const s = await setup();
    const { exec } = start(s, { command: "/simplify", completion: auto0 }, { type: "command" });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { text: "Ran /simplify" } });
    expect(s.invocations()[0]!.argv[0]).toBe("/simplify");
  });

  it("manual completion goes idle until done()", async () => {
    const s = await setup();
    const { ctx, exec, settled } = start(s, { prompt: "work", completion: { mode: "manual" } });
    await waitFor(() => ctx.current.status === "idle");
    expect(ctx.current.output?.text).toBe("Done: work");
    expect(settled()).toBeNull();
    exec.controls.done();
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { text: "Done: work" } });
  });

  it("marker completion: idle without token, success once the user steers to it", async () => {
    const s = await setup();
    const { ctx, exec } = start(s, { prompt: "step one", completion: { mode: "marker", token: "<<PG_DONE>>" } });
    await waitFor(() => ctx.current.status === "idle");
    expect(s.invocations()[0]!.argv[0]).toContain("end your final message with <<PG_DONE>>");
    s.ptys.userInput("nr-n1", "finish [[marker:<<PG_DONE>>]]\r");
    exec.controls.userInput!();
    expect(ctx.current.status).toBe("running");
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { text: "Done: finish\n<<PG_DONE>>" } });
  });

  it("permission prompt → waiting_input with reason; answering returns to running", async () => {
    const s = await setup();
    const { ctx, exec } = start(s, { prompt: "risky [[ask:Allow Bash?]]", completion: auto0 });
    await waitFor(() => ctx.current.status === "waiting_input");
    expect(ctx.current.waitingReason).toEqual({ kind: "notification", notificationType: "permission_prompt", message: "Allow Bash?" });
    s.ptys.userInput("nr-n1", "y\r");
    exec.controls.userInput!();
    expect(ctx.current).toMatchObject({ status: "running", waitingReason: null });
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { text: "Done: risky (answer: y)" } });
  });

  it("cancel, done or fail while a permission dialog is open never approves the pending tool call", async () => {
    for (const end of ["cancel", "done", "fail"] as const) {
      const s = await setup();
      const marker = path.join(s.dir, `PWNED-${end}`);
      const { ctx, exec } = start(s, { prompt: `risky [[permit:touch ${marker}]]`, completion: auto0 });
      await waitFor(() => ctx.current.status === "waiting_input");
      if (end === "cancel") await exec.controls.cancel();
      else exec.controls[end]();
      await exec.result;
      await new Promise((r) => setTimeout(r, 200));
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  it("auto grace is cancelled by user input", async () => {
    const s = await setup();
    const { ctx, exec, settled } = start(s, { prompt: "go", completion: { mode: "auto", graceSec: 1 } });
    await waitFor(() => ctx.current.output?.text);
    exec.controls.userInput!();
    await new Promise((r) => setTimeout(r, 1500));
    expect(settled()).toBeNull();
    exec.controls.done();
    expect((await exec.result).status).toBe("succeeded");
  });

  it("hold set before the first Stop makes the turn manual", async () => {
    const s = await setup();
    const { ctx, exec } = start(s, { prompt: "go [[sleep:200]]", completion: auto0 });
    exec.controls.setHold(true);
    await waitFor(() => ctx.current.status === "idle");
    exec.controls.fail("not good");
    expect(await exec.result).toMatchObject({ status: "failed", error: "not good", output: { text: "Done: go" } });
  });

  it("an unexpected exit fails the node", async () => {
    const s = await setup();
    const { exec } = start(s, { prompt: "boom [[crash]]", completion: auto0 });
    expect(await exec.result).toMatchObject({ status: "failed", error: "Claude exited unexpectedly (code 0)" });
  });

  it("cancel stops a hanging session", async () => {
    const s = await setup();
    const { ctx, exec } = start(s, { prompt: "forever [[hang]]", completion: auto0 });
    await waitFor(() => ctx.current.sessionId && s.hookCalls.includes("session-start"));
    await exec.controls.cancel();
    expect(await exec.result).toMatchObject({ status: "cancelled" });
    expect(s.ptys.get("nr-n1")!.isLive).toBe(false);
  });

  it("aborting the signal before spawn cancels without starting claude", async () => {
    const s = await setup();
    const { ctx, exec } = start(s, { prompt: "x", completion: auto0 });
    ctx.abort.abort();
    expect(await exec.result).toMatchObject({ status: "cancelled" });
    expect(s.invocations()).toEqual([]);
  });

  it("without autoTrustWorktrees the trust dialog puts the node in waiting_input", async () => {
    const s = await setup({ FAKE_CLAUDE_CHECK_TRUST: "1" });
    const { ctx, exec } = start(s, { prompt: "hello", completion: auto0 }, { settings: { autoTrustWorktrees: false } });
    await waitFor(() => ctx.current.status === "waiting_input");
    expect(ctx.current.waitingReason?.kind).toBe("trust_dialog");
    expect(fs.existsSync(path.join(s.env.CLAUDE_CONFIG_DIR!, ".claude.json"))).toBe(false);
    s.ptys.userInput("nr-n1", "1\r");
    exec.controls.userInput!();
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { text: "Done: hello" } });
  });

  it("context resume continues the predecessor session; interrupted retries resume their own", async () => {
    const s = await setup();
    const first = start(s, { prompt: "remember [[reply:ALPHA]]", completion: auto0 }, { id: "a" });
    await first.exec.result;
    const sid = first.ctx.current.sessionId!;

    const second = start(
      s,
      { prompt: "what did you say? [[recall]]", context: "resume", completion: auto0 },
      { id: "b", predecessors: [{ nodeId: "a", label: "A", type: "prompt", status: "succeeded", output: { text: "ALPHA" }, error: null, sessionId: sid, transcriptPath: null, laneId: "main" }] },
    );
    const secondResult = await second.exec.result;
    expect(secondResult).toMatchObject({ status: "succeeded", output: { text: "ALPHA" } });
    // The resumed transcript holds A's message too: B only reports the usage of its own turn.
    const firstUsage = (await first.exec.result).status === "succeeded" ? first.ctx.current.output?.usage : undefined;
    expect(secondResult.status === "succeeded" && secondResult.output.usage).toEqual(firstUsage);
    const inv = s.invocations()[1]!;
    expect(inv.argv.slice(0, 3)).toEqual(["what did you say? [[recall]]", "--resume", sid]);
    expect(inv.argv).not.toContain("--session-id");

    const retry = start(s, { prompt: "original", completion: auto0 }, { id: "c", previousAttempt: makeNodeRun("old", "c", { status: "interrupted", sessionId: sid }) });
    const retryResult = await retry.exec.result;
    expect(retryResult.status).toBe("succeeded");
    expect(retryResult.status === "succeeded" && retryResult.output.usage?.outputTokens).toBe(firstUsage?.outputTokens);
    expect(s.invocations()[2]!.argv.slice(0, 3)).toEqual([INTERRUPTED_MESSAGE, "--resume", sid]);
  });

  it("retrying an attempt interrupted after its turn finished resumes without a message and keeps the output", async () => {
    const s = await setup();
    const first = start(s, { prompt: "say ready [[reply:ready]]", completion: auto0 }, { id: "a" });
    await first.exec.result;
    const { sessionId, transcriptPath } = first.ctx.current;
    expect(transcriptPath).toBeTruthy();
    const previous = makeNodeRun("old", "a", { status: "interrupted", sessionId, transcriptPath, output: { text: "ready" } });
    const retry = start(s, { prompt: "say ready [[reply:ready]]", completion: auto0 }, { id: "a", previousAttempt: previous });
    expect(await retry.exec.result).toMatchObject({ status: "succeeded", output: { text: "ready" } });
    const argv = s.invocations()[1]!.argv;
    expect(argv.slice(0, 2)).toEqual(["--resume", sessionId]);
    expect(argv).not.toContain(INTERRUPTED_MESSAGE);
  });

  it("keeps the planned session id and never puts an option-like id into argv", async () => {
    const s = await setup();
    const { ctx, exec } = start(s, { prompt: "x", completion: auto0 });
    const planned = await waitFor(() => ctx.current.sessionId);
    await exec.result;
    expect(ctx.current.sessionId).toBe(planned);
    expect(() => buildClaudeArgs({ message: "m", sessionId: "x", resumeSessionId: "--dangerously-skip-permissions", name: "n", settingsPath: "s", permissionMode: "manual" })).toThrow(/Invalid session id/);
  });

  it("context resume in a later loop iteration continues its own session with the new context block", async () => {
    const s = await setup();
    const first = start(s, { prompt: "fix it", completion: auto0 }, { id: "fix" });
    await first.exec.result;
    const sid = first.ctx.current.sessionId!;
    const again = start(
      s,
      { prompt: "fix it", context: "resume", completion: auto0 },
      {
        id: "fix",
        previousIteration: makeNodeRun("fix-0", "fix", { status: "succeeded", sessionId: sid }),
        predecessors: [{ nodeId: "cond", label: "Green?", type: "condition", status: "succeeded", output: { port: "false", text: "2 tests fail" }, error: null, sessionId: null, transcriptPath: null, laneId: "main" }],
      },
    );
    expect(await again.exec.result).toMatchObject({ status: "succeeded" });
    const argv = s.invocations()[1]!.argv;
    expect(argv.slice(1, 3)).toEqual(["--resume", sid]);
    expect(argv[0]).toMatch(/^Context from previous steps:\n\n### Green\? \(condition, succeeded\)\nCondition result: false\n2 tests fail[\s\S]*fix it$/);
  });

  it("context resume without a predecessor session fails clearly", async () => {
    const s = await setup();
    const { exec } = start(s, { prompt: "x", context: "resume", completion: auto0 });
    const result = await exec.result;
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toMatch(/Context "resume"/);
  });

  it("reopen spawns claude --resume in a new PTY outside the run", async () => {
    const s = await setup();
    const { ctx, exec, run } = start(s, { prompt: "x", completion: auto0, permissionMode: "plan" });
    await exec.result;
    const first = await s.runner.reopen(run, ctx.current, makeLane(s.worktree), s.dir);
    const ptyId = first.ptyId;
    expect(ptyId).toMatch(/^reopen-/);
    expect(first.notice).toBeNull();
    const h = s.ptys.get(ptyId)!;
    expect(h.isLive).toBe(true);
    await waitFor(() => s.invocations().length === 2);
    expect(s.invocations()[1]!.argv).toEqual(["--resume", ctx.current.sessionId, "--permission-mode", "plan"]);
    // A second click returns the live session instead of starting another one on the same transcript.
    expect((await s.runner.reopen(run, ctx.current, makeLane(s.worktree), s.dir)).ptyId).toBe(ptyId);
    expect(s.runner.closeReopened("reopen-unknown")).toBe(false);
    expect(s.runner.closeReopened(ptyId)).toBe(true);
    await h.exited;
    // Worktree gone: main checkout, asks before edits, with a notice.
    const fallback = await s.runner.reopen(run, ctx.current, makeLane(path.join(s.dir, "gone")), s.dir);
    expect(fallback.ptyId).not.toBe(ptyId);
    expect(fallback.notice).toMatch(/main checkout/);
    await waitFor(() => s.invocations().length === 3);
    expect(s.invocations()[2]!.argv).toEqual(["--resume", ctx.current.sessionId, "--permission-mode", "default"]);
    expect(s.invocations()[2]!.cwd).toBe(fs.realpathSync(s.dir));
    s.runner.closeReopened(fallback.ptyId);
    await s.ptys.get(fallback.ptyId)!.exited;
    expect(fs.existsSync(ptyLogPath(s.paths, run.id, ptyId))).toBe(true);
    await expect(s.runner.reopen(run, makeNodeRun("z", "n1"), null, s.dir)).rejects.toThrow(/no Claude session/);
  });
});
