import fs from "node:fs";
import path from "node:path";
import {
  describeToolActivity,
  isClaudeNode,
  type ClaudeNode,
  type CompletionPolicy,
  type Effort,
  type GraphDefaults,
  type Lane,
  type NodeRun,
  type NodeRunOutput,
  type NodeStatus,
  type PermissionMode,
  type Run,
} from "@promptgraph/shared";
import { childEnv, claudeBin, type PgHookEnv } from "../../config/child-env.js";
import { hooksSettingsPath, ptyLogPath, runDir, type PgPaths } from "../../config/paths.js";
import type { HookMessage, HookRouter } from "../../hooks/hook-router.js";
import { hookToken } from "../../hooks/hook-token.js";
import type { PtyHandle, PtyManager } from "../../pty/pty-manager.js";
import type { NodeRunPatch } from "../../store/store.js";
import { newId, newSessionId } from "../../util/ids.js";
import { stripAnsi, errorMessage } from "../../util/text.js";
import type { NodeControls, NodeExecution, Runner, RunnerContext, RunnerResult } from "../types.js";
import { buildClaudeArgs, toCliPermissionMode } from "./args.js";
import { CompletionController } from "./completion.js";
import { buildInitialMessage, INTERRUPTED_MESSAGE } from "./context.js";
import { writeHooksSettings } from "./hooks-settings.js";
import {
  assistantMessageIds,
  isClaudeTranscriptPath,
  lastAssistantText,
  turnWritten,
  usageFromTranscript,
  waitForLastAssistantText,
  waitForTurnWritten,
} from "./transcript.js";
import { preTrustDirectory, TRUST_DIALOG_PATTERN } from "./trust.js";

export interface ServerEndpoint {
  port: number;
  token: string;
}

export interface ClaudeRunnerDeps {
  ptys: PtyManager;
  hooks: HookRouter;
  paths: PgPaths;
  /** Absolute path of the installed pg-hook (installPgHook). */
  pgHookPath: string;
  /** Filled once the HTTP server listens (hooks need the port). */
  endpoint: () => ServerEndpoint;
  env?: NodeJS.ProcessEnv;
}

/** Options of a Claude node after applying graph defaults. */
export interface ResolvedClaudeOptions {
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  completion: CompletionPolicy;
}

export function resolveClaudeOptions(node: ClaudeNode, defaults: GraphDefaults): ResolvedClaudeOptions {
  return {
    model: node.config.model ?? defaults.model,
    effort: node.config.effort ?? defaults.effort,
    permissionMode: node.config.permissionMode ?? defaults.permissionMode,
    allowedTools: node.config.allowedTools ?? defaults.allowedTools,
    completion: node.config.completion ?? defaults.completion,
  };
}

const PTY_COLS = 120;
const PTY_ROWS = 40;
/** §7.4: after "/exit", wait this long before killing. */
const EXIT_WAIT_MS = 3000;
/** Reopened sessions are ended with SIGTERM (a dialog may be open, so nothing is typed), then SIGKILL. */
const REOPEN_KILL_MS = 3000;
const KILL_WAIT_MS = 2000;
/** Lets the TUI register the typed command before Enter. */
const ENTER_DELAY_MS = 100;
const TRUST_WINDOW_CHARS = 4096;
const TRUST_MESSAGE = "Claude Code asks whether you trust this folder. Answer in the terminal.";
/** Claude Code session ids are UUIDs; anything else (e.g. from a forged hook) is never used in argv. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No SessionStart hook this long after the spawn: hooks are probably not reaching the server. */
const HOOK_LIVENESS_MS = 45_000;
const HOOKS_MISSING_MESSAGE =
  "No status reports from Claude Code yet: its hooks may not reach promptgraph (is curl installed?). Check the terminal, then mark the node Done or Failed.";

export function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * prompt/command nodes (§7). Per start:
 * 1. resolve options (node config ?? graph defaults); writeHooksSettings for the run (once);
 * 2. autoTrustWorktrees → preTrustDirectory(lane.worktreePath), else watch PTY output for
 *    TRUST_DIALOG_PATTERN → waiting_input {kind:"trust_dialog"};
 * 3. message = buildInitialMessage (or INTERRUPTED_MESSAGE + --resume when previousAttempt was
 *    interrupted; context "resume" → --resume <predecessor sessionId>);
 * 4. spawn claudeBin() in a PTY (id = nodeRun.id, logPath ptyLogPath) with childEnv(PG_PORT,
 *    PG_HOOK_HEADER_FILE, PG_NODE_RUN_ID); update {ptyId, sessionId, transcriptPath?}. The session
 *    token never reaches the child: the header file (0600, in the run dir) holds the node run's
 *    hookToken, valid only for its own /hooks/<nodeRunId>/* routes, and keeps it out of curl's argv;
 * 5. hooks: session-start → confirm sessionId/transcriptPath, status running; activity → activity text
 *    (describeToolActivity), waiting_input → running; notification → waiting_input {kind:"notification"};
 *    stop → output.text = last_assistant_message ?? transcript fallback, output.usage =
 *    usageFromTranscript minus the messages already in a resumed transcript, then CompletionController.onStop;
 * 6. ending → at the input prompt (turn ended) write "/exit\r", wait 3s, kill; otherwise (working, a
 *    permission/trust dialog may be open, where Enter would accept the default "Yes") SIGTERM directly;
 *    PTY exit before success → failed "Claude exited unexpectedly (code N)".
 */
export class ClaudeRunner implements Runner {
  /** Live "Reopen session" PTYs by node run id: one per node run. */
  private readonly reopened = new Map<string, { handle: PtyHandle; sessionId: string }>();
  /** Session ids used by live run-owned executions (with a count: one session may be resumed twice). */
  private readonly activeSessions = new Map<string, number>();

  constructor(private readonly deps: ClaudeRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const execution = new ClaudeExecution(this.deps, ctx, {
      claim: (sid) => this.claimSession(sid),
    });
    return { result: execution.result, controls: execution.controls };
  }

  /** True while a run-owned execution uses the session (Reopen would write to the same transcript). */
  isSessionActive(sessionId: string): boolean {
    return (this.activeSessions.get(sessionId) ?? 0) > 0;
  }

  /**
   * An execution is about to use `sessionId`: a live reopened PTY on it is ended first (two processes
   * must not append to one transcript). Returns the release callback.
   */
  private async claimSession(sessionId: string): Promise<() => void> {
    for (const r of this.reopened.values()) {
      if (r.sessionId !== sessionId || !r.handle.isLive) continue;
      r.handle.kill("SIGTERM");
      if (!(await exitsWithin(r.handle, REOPEN_KILL_MS))) r.handle.kill("SIGKILL");
    }
    this.activeSessions.set(sessionId, (this.activeSessions.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.activeSessions.get(sessionId) ?? 1) - 1;
      if (n > 0) this.activeSessions.set(sessionId, n);
      else this.activeSessions.delete(sessionId);
    };
  }

  /**
   * "Reopen session" (§7.3): `claude --resume <nodeRun.sessionId>` in a new PTY in the lane worktree
   * (or the repo if the worktree is gone), not tracked by the run. Returns its ptyId (`reopen-<id>`) and,
   * when it runs in the main checkout, a notice; while that PTY is live, the same id is returned instead
   * of starting a second session on the transcript. In the main checkout the session asks before every
   * edit (permission mode "default"), whatever the node's mode was. Callers refuse while a run-owned
   * execution uses the session (isSessionActive).
   */
  async reopen(run: Run, nodeRun: NodeRun, lane: Lane | null, repoPath: string): Promise<{ ptyId: string; notice: string | null }> {
    const sessionId = nodeRun.sessionId;
    if (!sessionId) throw new Error("This node run has no Claude session to reopen");
    if (!isSessionId(sessionId)) throw new Error("This node run's session id is not valid");
    const existing = this.reopened.get(nodeRun.id);
    if (existing?.handle.isLive) return { ptyId: existing.handle.id, notice: null };
    const env = this.deps.env ?? process.env;
    const inWorktree = !!lane && fs.existsSync(lane.worktreePath);
    const cwd = inWorktree ? lane.worktreePath : repoPath;
    if (inWorktree && run.graphSnapshot.settings.autoTrustWorktrees) await preTrustDirectory(cwd, env);
    const node = run.graphSnapshot.nodes.find((n) => n.id === nodeRun.nodeId);
    const defaults = run.graphSnapshot.settings.defaults;
    const opts = node && isClaudeNode(node) ? resolveClaudeOptions(node, defaults) : null;
    const mode = inWorktree ? toCliPermissionMode(opts?.permissionMode ?? defaults.permissionMode) : "default";
    const args = ["--resume", sessionId, "--permission-mode", mode];
    if (opts?.model) args.push("--model", opts.model);
    if (opts?.effort) args.push("--effort", opts.effort);
    const id = `reopen-${newId()}`;
    const handle = this.deps.ptys.spawn({
      id,
      file: claudeBin(env),
      args,
      cwd,
      env: childEnv({}, env),
      cols: PTY_COLS,
      rows: PTY_ROWS,
      logPath: ptyLogPath(this.deps.paths, run.id, id),
    });
    this.reopened.set(nodeRun.id, { handle, sessionId });
    void handle.exited.then(() => {
      if (this.reopened.get(nodeRun.id)?.handle === handle) this.reopened.delete(nodeRun.id);
    });
    const notice = inWorktree
      ? null
      : `The run's worktree is gone: this session runs in your main checkout (${repoPath}) and asks before every edit.`;
    return { ptyId: id, notice };
  }

  /** Ends a live reopened session (its terminal tab was closed). False when no such PTY is live. */
  closeReopened(ptyId: string): boolean {
    const handle = [...this.reopened.values()].map((r) => r.handle).find((h) => h.id === ptyId);
    if (!handle?.isLive) return false;
    handle.kill("SIGTERM");
    void exitsWithin(handle, REOPEN_KILL_MS).then((exited) => exited || handle.kill("SIGKILL"));
    return true;
  }
}

type Ending = { kind: "succeeded" } | { kind: "failed"; reason: string } | { kind: "cancelled" };

interface LaunchPlan {
  node: ClaudeNode;
  options: ResolvedClaudeOptions;
  message: string;
  sessionId: string;
  resumeSessionId?: string;
  /** Transcript of the resumed session, when known before the start. */
  resumeTranscriptPath?: string | null;
  /**
   * Retry of an attempt interrupted after its turn had finished (idle / grace period): the session is
   * resumed without a message and the previous output stands, as if that turn just stopped.
   */
  resumeIdle?: { text: string | null };
}

interface SessionRegistry {
  claim(sessionId: string): Promise<() => void>;
}

/** One live Claude node run: PTY + hooks + completion policy. */
class ClaudeExecution {
  readonly result: Promise<RunnerResult>;
  readonly controls: NodeControls;
  private resolveResult!: (r: RunnerResult) => void;
  private readonly env: NodeJS.ProcessEnv;
  private status: NodeStatus;
  private handle: PtyHandle | null = null;
  private ending: Ending | null = null;
  private controller: CompletionController | null = null;
  private output: NodeRunOutput = {};
  private transcriptPath: string | null;
  /**
   * A Stop arrived and no activity/input/dialog since: Claude sits at its input prompt, an idle_prompt
   * notification adds nothing, and typing "/exit" is safe.
   */
  private turnEnded = false;
  /** Assistant message ids already in a resumed transcript: their usage is not this node's. */
  private usageBaseline: ReadonlySet<string> | null = null;
  private resuming = false;
  /** Hold may be toggled before the controller exists (or persisted from an earlier start). */
  private hold: boolean;
  private hookChain: Promise<void> = Promise.resolve();
  private readonly cleanups: Array<() => void> = [];
  private plannedSessionId: string | null = null;
  private resumeIdle: LaunchPlan["resumeIdle"] = undefined;
  private sessionStarted = false;

  constructor(
    private readonly deps: ClaudeRunnerDeps,
    private readonly ctx: RunnerContext,
    private readonly sessions: SessionRegistry,
  ) {
    this.env = deps.env ?? process.env;
    this.status = ctx.nodeRun.status;
    this.transcriptPath = ctx.nodeRun.transcriptPath;
    this.hold = ctx.nodeRun.hold;
    this.result = new Promise((resolve) => (this.resolveResult = resolve));
    this.controls = {
      done: () => this.end({ kind: "succeeded" }),
      fail: (reason) => this.end({ kind: "failed", reason: reason || "Marked as failed by the user" }),
      setHold: (hold) => {
        this.hold = hold;
        this.controller?.setHold(hold);
      },
      userInput: () => this.onUserInput(),
      cancel: async () => {
        this.end({ kind: "cancelled" });
        await this.result;
      },
    };
    const onAbort = () => this.end({ kind: "cancelled" });
    if (ctx.signal.aborted) onAbort();
    else {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      this.cleanups.push(() => ctx.signal.removeEventListener("abort", onAbort));
    }
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const plan = this.plan();
      const { run, lane, nodeRun } = this.ctx;
      this.plannedSessionId = plan.sessionId;
      this.resumeIdle = plan.resumeIdle;
      if (plan.resumeSessionId && !isSessionId(plan.resumeSessionId)) throw new Error("The session to resume has an invalid id");
      this.cleanups.push(await this.sessions.claim(plan.sessionId));
      const settingsPath = writeHooksSettings(hooksSettingsPath(this.deps.paths, run.id), this.deps.pgHookPath);
      const autoTrust = run.graphSnapshot.settings.autoTrustWorktrees;
      if (autoTrust) await preTrustDirectory(lane.worktreePath, this.env);
      if (this.ending) return this.settle(this.endingResult(null));

      this.controller = new CompletionController(plan.options.completion, {
        succeed: () => this.end({ kind: "succeeded" }),
        idle: () => this.update({ status: "idle", waitingReason: null }),
        resume: () => this.update({ status: "running", waitingReason: null }),
        holdReleased: () => {
          this.hold = false;
          this.update({ hold: false });
        },
      });
      this.controller.setHold(this.hold);
      this.cleanups.push(() => this.controller?.dispose());
      this.cleanups.push(this.deps.hooks.register(nodeRun.id, (m) => this.enqueueHook(m)));

      this.resuming = plan.resumeSessionId !== undefined;
      if (this.resuming && plan.resumeTranscriptPath) this.usageBaseline = assistantMessageIds(plan.resumeTranscriptPath);
      const endpoint = this.deps.endpoint();
      const headerFile = this.writeHookHeader(endpoint.token);
      const args = buildClaudeArgs({
        message: plan.message,
        sessionId: plan.sessionId,
        resumeSessionId: plan.resumeSessionId,
        name: `pg:${run.graphId}/${plan.node.label || plan.node.id}`,
        settingsPath,
        permissionMode: plan.options.permissionMode,
        model: plan.options.model,
        effort: plan.options.effort,
        allowedTools: plan.options.allowedTools,
      });
      this.handle = this.deps.ptys.spawn({
        id: nodeRun.id,
        file: claudeBin(this.env),
        args,
        cwd: lane.worktreePath,
        env: childEnv({ PG_PORT: String(endpoint.port), PG_HOOK_HEADER_FILE: headerFile, PG_NODE_RUN_ID: nodeRun.id } satisfies PgHookEnv, this.env),
        cols: PTY_COLS,
        rows: PTY_ROWS,
        logPath: ptyLogPath(this.deps.paths, run.id, nodeRun.id),
      });
      this.update({ ptyId: this.handle.id, sessionId: plan.sessionId });
      if (!autoTrust) this.watchTrustDialog(this.handle);
      this.watchHookLiveness();

      const exit = await this.handle.exited;
      await this.hookChain;
      this.settle(this.endingResult(exit.code));
    } catch (err) {
      if (this.ending?.kind === "cancelled") this.settle({ status: "cancelled", output: this.finalOutput() });
      else this.settle({ status: "failed", error: errorMessage(err), output: this.finalOutput() });
    }
  }

  private plan(): LaunchPlan {
    const { node, run, predecessors, previousAttempt, nodeRun } = this.ctx;
    if (!isClaudeNode(node)) throw new Error(`ClaudeRunner cannot run ${node.type} nodes`);
    const options = resolveClaudeOptions(node, run.graphSnapshot.settings.defaults);
    if (previousAttempt?.status === "interrupted" && previousAttempt.sessionId) {
      const sid = previousAttempt.sessionId;
      const transcript = previousAttempt.transcriptPath;
      const resume = { node, options, sessionId: sid, resumeSessionId: sid, resumeTranscriptPath: transcript };
      // The turn had already finished (idle, awaiting Done, or in the grace period): nothing to continue.
      if (previousAttempt.output?.text && transcript && turnWritten(transcript)) {
        return { ...resume, message: "", resumeIdle: { text: previousAttempt.output.text } };
      }
      return { ...resume, message: INTERRUPTED_MESSAGE };
    }
    const message = buildInitialMessage(node, predecessors, options.completion);
    if (node.config.context === "resume") {
      // §15.4: inside a loop, later iterations continue the node's own session (it remembers what it tried),
      // with this iteration's context block (e.g. the new failing test output or the judge's reason).
      const own = this.ctx.previousIteration;
      if (own?.sessionId) {
        const withContext = buildInitialMessage(asFresh(node), predecessors, options.completion);
        return { node, options, message: withContext, sessionId: own.sessionId, resumeSessionId: own.sessionId, resumeTranscriptPath: own.transcriptPath };
      }
      const pred = predecessors.find(
        (p) => (p.type === "prompt" || p.type === "command") && p.sessionId && p.laneId === nodeRun.laneId,
      );
      if (!pred?.sessionId && this.ctx.inLoopBody) {
        // First pass of a loop step without a Claude predecessor to continue: a new session with context.
        return { node, options, message: buildInitialMessage(asFresh(node), predecessors, options.completion), sessionId: newSessionId() };
      }
      if (!pred?.sessionId) throw new Error('Context "resume" needs a predecessor Claude node with a session in the same lane');
      return { node, options, message, sessionId: pred.sessionId, resumeSessionId: pred.sessionId, resumeTranscriptPath: pred.transcriptPath };
    }
    return { node, options, message, sessionId: newSessionId() };
  }

  private enqueueHook(message: HookMessage): void {
    this.hookChain = this.hookChain.then(() => this.onHook(message)).catch(() => undefined);
  }

  private async onHook(m: HookMessage): Promise<void> {
    if (this.ending) return;
    switch (m.event) {
      case "session-start": {
        this.sessionStarted = true;
        this.transcriptPath = this.acceptTranscript(m.payload.transcript_path);
        // Fallback when the resumed transcript was unknown at start: SessionStart precedes the first turn.
        if (this.resuming && !this.usageBaseline && this.transcriptPath) this.usageBaseline = assistantMessageIds(this.transcriptPath);
        // Only a well-formed id is kept: it is later passed to `claude --resume`.
        const sessionId = isSessionId(m.payload.session_id) ? m.payload.session_id : (this.plannedSessionId ?? undefined);
        this.update({ sessionId, transcriptPath: this.transcriptPath, status: "running", waitingReason: null });
        if (this.resumeIdle) {
          const { text } = this.resumeIdle;
          this.resumeIdle = undefined;
          this.turnEnded = true;
          if (text !== null) this.output = { ...this.output, text };
          this.update({ output: this.output });
          this.controller?.onStop(text);
        }
        return;
      }
      case "activity":
        this.turnEnded = false;
        this.controller?.onActivity();
        this.update({ activity: describeToolActivity(m.payload), ...this.leaveWaiting() });
        return;
      case "notification":
        if (m.payload.notification_type === "idle_prompt" && (this.turnEnded || this.status === "idle")) return;
        if (m.payload.notification_type !== "idle_prompt") this.turnEnded = false;
        this.update({
          status: "waiting_input",
          waitingReason: {
            kind: "notification",
            notificationType: m.payload.notification_type,
            message: m.payload.message || "Claude needs your input",
          },
        });
        return;
      case "stop": {
        this.transcriptPath = this.acceptTranscript(m.payload.transcript_path);
        const transcript = this.transcriptPath;
        const hookText = m.payload.last_assistant_message;
        const text = hookText ?? (transcript ? await waitForLastAssistantText(transcript) : null);
        // The text came from the hook, but the usage needs the turn's line in the transcript.
        if (hookText !== undefined && transcript) await waitForTurnWritten(transcript);
        if (this.ending) return;
        this.turnEnded = true;
        this.output = { ...this.output, ...(text !== null ? { text } : {}), ...(transcript ? { usage: this.usageOf(transcript) } : {}) };
        this.update({ output: this.output, transcriptPath: transcript, ...this.leaveWaiting() });
        this.controller?.onStop(text);
        return;
      }
    }
  }

  /** A hook-reported transcript path is used only when it looks like Claude Code's own. */
  private acceptTranscript(reported: string | undefined): string | null {
    if (reported !== undefined && reported !== this.transcriptPath && isClaudeTranscriptPath(reported, this.env)) return reported;
    return this.transcriptPath;
  }

  /** No SessionStart in time → waiting_input with a reason, so the node does not sit in "running" silently. */
  private watchHookLiveness(): void {
    const timer = setTimeout(() => {
      if (this.sessionStarted || this.ending || this.status !== "running") return;
      this.update({ status: "waiting_input", waitingReason: { kind: "other", message: HOOKS_MISSING_MESSAGE } });
    }, HOOK_LIVENESS_MS);
    timer.unref?.();
    this.cleanups.push(() => clearTimeout(timer));
  }

  private onUserInput(): void {
    if (this.ending) return;
    this.turnEnded = false;
    this.controller?.onUserInput();
    const patch = this.leaveWaiting();
    if (patch.status) this.update(patch);
  }

  /** waiting_input → running (activity, answer typed, turn finished). */
  private leaveWaiting(): NodeRunPatch {
    return this.status === "waiting_input" ? { status: "running", waitingReason: null } : {};
  }

  private watchTrustDialog(handle: PtyHandle): void {
    let window = "";
    const off = handle.onData((chunk) => {
      window = (window + stripAnsi(chunk.toString("utf8")).replace(/\s+/g, "")).slice(-TRUST_WINDOW_CHARS);
      if (!TRUST_DIALOG_PATTERN.test(window)) return;
      off();
      if (this.status === "running") this.update({ status: "waiting_input", waitingReason: { kind: "trust_dialog", message: TRUST_MESSAGE } });
    });
    this.cleanups.push(off);
  }

  /** First ending wins; asks Claude to exit, then kills it (§7.4). */
  private end(ending: Ending): void {
    if (this.ending) return;
    this.ending = ending;
    this.controller?.dispose();
    void this.stopProcess();
  }

  private async stopProcess(): Promise<void> {
    const h = this.handle;
    if (!h?.isLive) return;
    // Only at the input prompt: in a select dialog (permission, trust) the typed text matches no option
    // and Enter would accept the highlighted default ("Yes").
    if (this.turnEnded) {
      h.write("/exit");
      await sleep(ENTER_DELAY_MS);
      h.write("\r");
      if (await exitsWithin(h, EXIT_WAIT_MS)) return;
    }
    h.kill("SIGTERM");
    if (await exitsWithin(h, KILL_WAIT_MS)) return;
    h.kill("SIGKILL");
  }

  private endingResult(exitCode: number | null): RunnerResult {
    const ending = this.ending;
    if (!ending) {
      return { status: "failed", error: `Claude exited unexpectedly (code ${exitCode ?? "signal"})`, output: this.finalOutput() };
    }
    if (ending.kind === "cancelled") return { status: "cancelled", output: this.finalOutput() };
    if (ending.kind === "failed") return { status: "failed", error: ending.reason, output: this.finalOutput() };
    return { status: "succeeded", output: this.finalOutput() };
  }

  /** Output with usage re-read from the transcript (later turns may have added usage). */
  private finalOutput(): NodeRunOutput {
    const transcript = this.transcriptPath;
    if (!transcript || !fs.existsSync(transcript)) return this.output;
    const text = this.output.text ?? lastAssistantText(transcript) ?? undefined;
    return { ...this.output, ...(text !== undefined ? { text } : {}), usage: this.usageOf(transcript) };
  }

  private usageOf(transcript: string): NonNullable<NodeRunOutput["usage"]> {
    return usageFromTranscript(transcript, this.usageBaseline ?? undefined);
  }

  /** `Authorization: Bearer <hookToken>` for curl's `-H @file`, readable by the user only. */
  private writeHookHeader(sessionToken: string): string {
    const { run, nodeRun } = this.ctx;
    const file = path.join(runDir(this.deps.paths, run.id), `hook-${nodeRun.id}.header`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, `Authorization: Bearer ${hookToken(sessionToken, nodeRun.id)}\n`, { mode: 0o600 });
    this.cleanups.push(() => fs.rmSync(file, { force: true }));
    return file;
  }

  private settle(result: RunnerResult): void {
    for (const c of this.cleanups.splice(0)) c();
    this.resolveResult(result);
  }

  /** Persists through the engine; a rejected patch (e.g. node already final) is not fatal for the runner. */
  private update(patch: NodeRunPatch): void {
    if (patch.status) this.status = patch.status;
    try {
      const nodeRun = this.ctx.update(patch);
      if (nodeRun?.status) this.status = nodeRun.status;
    } catch {
      // The engine owns statuses; ignore patches it refuses.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function exitsWithin(h: PtyHandle, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  const exited = await Promise.race([h.exited.then(() => true as const), timeout]);
  clearTimeout(timer);
  return exited;
}

/** The node with context "fresh": its initial message carries the context block of its predecessors. */
function asFresh(node: ClaudeNode): ClaudeNode {
  return { ...node, config: { ...node.config, context: "fresh" as const } } as ClaudeNode;
}
