import { randomUUID } from "node:crypto";
import {
  CHAT_TITLE_MAX_CHARS,
  withChatContext,
  type ChatContext,
  type ChatItem,
  type ChatPermissionRequestItem,
  type ChatSessionDetail,
  type ChatSessionSummary,
  type ChatStatus,
} from "@promptgraph/shared";
import { childEnv, claudeBin } from "../config/child-env.js";
import type { ChatServerMessage, EventBus } from "../events/bus.js";
import type { ChatSessionRecord, Store } from "../store/store.js";
import { errorMessage, tailLines } from "../util/text.js";
import { buildChatArgs, type ChatMcpLaunch } from "./launch.js";
import { NdjsonParser } from "./ndjson.js";
import { ChatNormalizer, type ChatEvent } from "./normalize.js";
import { spawnChatProcess, type ChatChild, type ChatChildExit, type ChatSpawner } from "./process.js";
import { controlErrorLine, interruptLine, permissionResponseLine, userTurnLine } from "./protocol.js";
import { chatItemsFromTranscript, findChatTranscript } from "./transcript.js";

export const CHAT_IDLE_TIMEOUT_MS = 15 * 60_000;
/** Shutdown: stdin is closed, SIGTERM after this, SIGKILL after twice this. */
export const CHAT_SHUTDOWN_GRACE_MS = 3_000;
/** Title shown until the first user message. */
export const UNTITLED_CHAT = "New chat";
/** Oldest items are dropped beyond this (the transcript keeps everything). */
const MAX_ITEMS = 5_000;
const STDERR_TAIL_CHARS = 8_000;

export type ChatErrorCode = "not_found" | "invalid_state";

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export interface ChatManagerOptions {
  store: Store;
  bus: EventBus;
  /** Repository id: stamped on every chat:* message so the WsHub delivers it to that repository's subscribers. */
  repoId: string;
  /** Repository root: cwd of every chat process (the main checkout). */
  repoPath: string;
  /** Base env (claudeBin + childEnv; also locates transcripts via CLAUDE_CONFIG_DIR). */
  env?: NodeJS.ProcessEnv;
  /** How the promptgraph MCP server is connected; called once, on the first spawn. */
  mcp: () => ChatMcpLaunch;
  spawner?: ChatSpawner;
  idleTimeoutMs?: number;
  shutdownGraceMs?: number;
  now?: () => number;
  newSessionId?: () => string;
}

/** A chat:* message before publish() stamps the repository on it. */
type ChatMessageBody = ChatServerMessage extends infer M ? (M extends ChatServerMessage ? Omit<M, "repoId"> : never) : never;

/** One live Claude Code process of a session. */
interface ChatProcess {
  child: ChatChild;
  normalizer: ChatNormalizer;
  /**
   * User turns written and not yet ended by a `result`: 0 or 1. Claude Code merges user lines written during a
   * running turn into that turn (one `result` for several lines), so the next queued turn is written only after
   * the previous `result` (see `pump`).
   */
  pendingTurns: number;
  permissions: Map<string, ChatPermissionRequestItem>;
  /** messageId → text streamed so far (chat:delta) whose final assistant item has not arrived yet. */
  streaming: Map<string, string>;
  stderr: string;
  /** Session cost before this process; Claude Code reports a cumulative total per process. */
  costBase: number;
  /** We closed it (idle, delete, shutdown): its exit is not an error. */
  stopping: boolean;
  idleTimer: NodeJS.Timeout | null;
  killTimers: NodeJS.Timeout[];
  exited: Promise<void>;
  markExited: () => void;
}

interface ChatSessionState {
  record: ChatSessionRecord;
  status: ChatStatus;
  /** Model reported by Claude Code (system/init). */
  reportedModel: string | null;
  /** null until loaded (from memory or the transcript). */
  items: ChatItem[] | null;
  proc: ChatProcess | null;
  /**
   * FIFO of user turns not written to stdin yet: sent while a turn was running, or while a closing process was
   * still exiting (then written to the next process).
   */
  queued: string[];
  /** Deleted: late output of its closing process is ignored. */
  deleted: boolean;
  nextItem: number;
}

/**
 * Chat panel sessions (DESIGN §21). One ChatSession per chat; its `claude -p` stream-json process is
 * spawned lazily on the first message, killed after the idle timeout and respawned with `--resume`.
 * Every change is published on the bus as a chat:* server message (broadcast by the WsHub).
 */
export class ChatManager {
  private readonly sessions = new Map<string, ChatSessionState>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawner: ChatSpawner;
  private readonly idleTimeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly newSessionId: () => string;
  private mcpLaunch: ChatMcpLaunch | null = null;
  private interrupts = 0;
  private closing = false;

  constructor(private readonly opts: ChatManagerOptions) {
    this.env = opts.env ?? process.env;
    this.spawner = opts.spawner ?? spawnChatProcess;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS;
    this.graceMs = opts.shutdownGraceMs ?? CHAT_SHUTDOWN_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.newSessionId = opts.newSessionId ?? randomUUID;
  }

  // --- queries ---------------------------------------------------------------

  list(): ChatSessionSummary[] {
    return this.opts.store.listChatSessions(this.opts.repoPath).map((record) => this.summary(this.state(record.id, record)!));
  }

  get(id: string): ChatSessionDetail | undefined {
    const session = this.state(id);
    if (!session) return undefined;
    const items = this.items(session);
    const proc = session.proc;
    return {
      session: this.summary(session),
      items: [...items],
      pendingPermissions: proc ? [...proc.permissions.values()] : [],
      streaming: proc ? [...proc.streaming].map(([messageId, text]) => ({ messageId, text })) : [],
    };
  }

  // --- commands --------------------------------------------------------------

  create(opts: { model?: string } = {}): ChatSessionSummary {
    const record = this.opts.store.insertChatSession({ id: this.newSessionId(), repoPath: this.opts.repoPath, model: opts.model ?? null });
    const session = this.state(record.id, record)!;
    session.items = [];
    const summary = this.summary(session);
    this.publish({ type: "chat:session", session: summary });
    return summary;
  }

  /** Kills the process and deletes the metadata; Claude's transcript stays on disk. */
  delete(id: string): boolean {
    const session = this.state(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.deleted = true;
    session.queued = [];
    const proc = session.proc;
    // Detach first: output still in the pipe (or flushed on SIGTERM) must not touch the deleted row.
    session.proc = null;
    if (proc) void this.stopProcess(proc, { immediate: true });
    this.opts.store.deleteChatSession(id);
    this.publish({ type: "chat:deleted", sessionId: id });
    return true;
  }

  /** Sends one user turn; spawns (or resumes) the process when there is none. */
  send(id: string, text: string, context: ChatContext): void {
    if (this.closing) throw new ChatError("invalid_state", "The server is shutting down");
    const session = this.require(id);
    this.items(session);
    if (session.record.title === null) {
      session.record = this.opts.store.updateChatSession(id, { title: chatTitle(text) });
    } else {
      session.record = this.opts.store.updateChatSession(id, {});
    }
    this.pushItem(session, { id: this.itemId(session), ts: this.now(), kind: "user", text });
    session.queued.push(userTurnLine(withChatContext(context, text)));
    const proc = session.proc;
    if (proc?.stopping) {
      // The previous process is exiting (idle timeout): the turn goes to the next one.
      this.setStatus(session, "starting");
      return;
    }
    if (proc) {
      this.clearIdle(proc);
      // A turn is running: this one waits in the FIFO until its `result`.
      if (proc.pendingTurns === 0) this.pump(session, proc);
      return;
    }
    this.spawn(session);
  }

  /** Stops the current turn. Open permission prompts are resolved as denied by "interrupt". */
  interrupt(id: string): void {
    const session = this.require(id);
    const proc = session.proc;
    session.queued = [];
    if (!proc || proc.stopping || proc.pendingTurns === 0) return;
    proc.child.writeLine(interruptLine(`pg-interrupt-${++this.interrupts}`));
    this.resolvePermissions(session, proc, "interrupt");
    if (session.status === "waiting_permission") this.setStatus(session, "thinking");
  }

  /** Answers a `can_use_tool` prompt. */
  answerPermission(id: string, requestId: string, allow: boolean, message?: string): void {
    const session = this.require(id);
    const proc = session.proc;
    const request = proc?.permissions.get(requestId);
    if (!proc || !request) throw new ChatError("invalid_state", `No pending permission request ${requestId}`);
    proc.permissions.delete(requestId);
    proc.child.writeLine(
      permissionResponseLine(
        requestId,
        allow ? { allow: true, input: request.input } : { allow: false, message: message?.trim() || "The user denied this tool call" },
      ),
    );
    this.pushItem(session, { id: this.itemId(session), ts: this.now(), kind: "permission_resolved", requestId, allowed: allow, by: "user" });
    this.setStatus(session, proc.permissions.size > 0 ? "waiting_permission" : "thinking");
  }

  /** Server shutdown: closes every process's stdin, SIGTERM after the grace period. */
  async shutdown(): Promise<void> {
    this.closing = true;
    const exits: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      session.queued = [];
      if (session.proc) exits.push(this.stopProcess(session.proc, { immediate: false }));
    }
    await Promise.all(exits);
  }

  // --- process ---------------------------------------------------------------

  private spawn(session: ChatSessionState): void {
    const mcp = (this.mcpLaunch ??= this.opts.mcp());
    const record = session.record;
    const args = buildChatArgs({
      sessionId: record.id,
      resume: record.started,
      title: record.title ?? UNTITLED_CHAT,
      mcp,
      model: record.model,
    });
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    let child: ChatChild;
    try {
      child = this.spawner({ command: claudeBin(this.env), args, cwd: this.opts.repoPath, env: childEnv(mcp.env, this.env) });
    } catch (err) {
      this.pushItem(session, { id: this.itemId(session), ts: this.now(), kind: "error", message: `Could not start Claude Code: ${errorMessage(err)}` });
      this.setStatus(session, "error");
      return;
    }
    const proc: ChatProcess = {
      child,
      normalizer: new ChatNormalizer({ newId: () => this.itemId(session), now: this.now, cwd: this.opts.repoPath }),
      pendingTurns: 0,
      permissions: new Map(),
      streaming: new Map(),
      stderr: "",
      costBase: record.totalCostUsd,
      stopping: false,
      idleTimer: null,
      killTimers: [],
      exited,
      markExited,
    };
    session.proc = proc;
    const parser = new NdjsonParser((line) => {
      // Runs inside a stream listener: nothing may throw out of it (it would crash the server).
      try {
        for (const event of proc.normalizer.handle(line)) this.apply(session, proc, event);
      } catch (err) {
        console.error(`[chat] ${session.record.id}: could not handle a Claude Code line: ${errorMessage(err)}`);
      }
    });
    child.onStdout((chunk) => parser.push(chunk));
    child.onStderr((chunk) => {
      proc.stderr = (proc.stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    child.onExit((exit) => {
      parser.flush();
      try {
        this.exited(session, proc, exit);
      } catch (err) {
        console.error(`[chat] ${session.record.id}: could not handle the process exit: ${errorMessage(err)}`);
      }
    });
    this.setStatus(session, "starting");
    this.pump(session, proc);
  }

  /** Writes the next queued turn when none is running (at most one turn in flight per process). */
  private pump(session: ChatSessionState, proc: ChatProcess): void {
    if (proc.stopping || proc.pendingTurns > 0 || session.queued.length === 0) return;
    const turn = session.queued.shift()!;
    if (!proc.child.writeLine(turn)) {
      // stdin already closed: the exit handler respawns with the queued turn.
      session.queued.unshift(turn);
      proc.stopping = true;
      this.setStatus(session, "starting");
      return;
    }
    proc.pendingTurns = 1;
    if (session.status !== "starting") this.setStatus(session, proc.permissions.size > 0 ? "waiting_permission" : "thinking");
  }

  private apply(session: ChatSessionState, proc: ChatProcess, event: ChatEvent): void {
    if (session.deleted || session.proc !== proc) return;
    const id = session.record.id;
    switch (event.kind) {
      case "init":
        if (event.model) session.reportedModel = event.model;
        if (!session.record.started) session.record = this.opts.store.updateChatSession(id, { started: true });
        if (session.status === "starting") this.setStatus(session, "thinking");
        return;
      case "delta":
      {
        const before = proc.streaming.get(event.messageId) ?? "";
        proc.streaming.set(event.messageId, before + event.text);
        return this.publish({ type: "chat:delta", sessionId: id, messageId: event.messageId, text: event.text, offset: before.length });
      }
      case "item":
        if (event.item.kind === "assistant") proc.streaming.delete(event.item.messageId);
        return this.pushItem(session, event.item);
      case "permission":
        proc.permissions.set(event.item.requestId, event.item);
        this.pushItem(session, event.item);
        return this.setStatus(session, "waiting_permission");
      case "unsupported_control":
        proc.child.writeLine(controlErrorLine(event.requestId, `promptgraph chat does not support control request "${event.subtype}"`));
        return;
      case "control_response":
        return;
      case "result": {
        const before = session.record.totalCostUsd;
        // total_cost_usd is cumulative for the process; never let the session total go down.
        const total = event.totalCostUsd === undefined ? before : Math.max(before, proc.costBase + event.totalCostUsd);
        const turnCost = total - before;
        this.resolvePermissions(session, proc, "interrupt");
        proc.streaming.clear();
        this.pushItem(session, { ...event.item, ...(event.totalCostUsd !== undefined ? { costUsd: roundUsd(turnCost) } : {}) });
        session.record = this.opts.store.updateChatSession(id, { totalCostUsd: total });
        proc.pendingTurns = 0;
        if (session.queued.length > 0 && !proc.stopping) {
          this.publishSession(session);
          this.pump(session, proc);
        } else {
          this.setStatus(session, "idle", true);
          this.armIdle(session, proc);
        }
        return;
      }
    }
  }

  private exited(session: ChatSessionState, proc: ChatProcess, exit: ChatChildExit): void {
    this.clearIdle(proc);
    for (const t of proc.killTimers) clearTimeout(t);
    proc.markExited();
    if (session.proc !== proc) return;
    session.proc = null;
    if (this.sessions.get(session.record.id) !== session) return; // deleted
    this.resolvePermissions(session, proc, "exit");
    if (exit.error) {
      this.pushItem(session, { id: this.itemId(session), ts: this.now(), kind: "error", message: `Could not start Claude Code: ${exit.error.message}` });
      session.queued = [];
      return this.setStatus(session, "error");
    }
    const failed = !proc.stopping && (proc.pendingTurns > 0 || (exit.code !== 0 && exit.code !== null) || exit.signal !== null);
    if (failed) {
      const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      const detail = tailLines(proc.stderr.trim(), 20);
      this.pushItem(session, {
        id: this.itemId(session),
        ts: this.now(),
        kind: "error",
        message: `Claude Code exited (${how})${detail ? `: ${detail}` : ""}`,
      });
    }
    if (session.queued.length > 0 && !this.closing) return this.spawn(session);
    this.setStatus(session, failed ? "error" : "exited");
  }

  /** Closes stdin; SIGTERM after the grace period (at once when `immediate`), SIGKILL after twice it. */
  private stopProcess(proc: ChatProcess, opts: { immediate: boolean }): Promise<void> {
    this.clearIdle(proc);
    if (!proc.stopping) {
      proc.stopping = true;
      proc.child.endInput();
      if (opts.immediate) proc.child.kill("SIGTERM");
      else proc.killTimers.push(unref(setTimeout(() => proc.child.kill("SIGTERM"), this.graceMs)));
      proc.killTimers.push(unref(setTimeout(() => proc.child.kill("SIGKILL"), this.graceMs * 2)));
    } else if (opts.immediate) {
      proc.child.kill("SIGTERM");
    }
    return proc.exited;
  }

  private armIdle(session: ChatSessionState, proc: ChatProcess): void {
    this.clearIdle(proc);
    proc.idleTimer = unref(
      setTimeout(() => {
        proc.idleTimer = null;
        if (session.proc === proc && proc.pendingTurns === 0) void this.stopProcess(proc, { immediate: false });
      }, this.idleTimeoutMs),
    );
  }

  private clearIdle(proc: ChatProcess): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = null;
  }

  private resolvePermissions(session: ChatSessionState, proc: ChatProcess, by: "interrupt" | "exit"): void {
    for (const requestId of proc.permissions.keys()) {
      this.pushItem(session, { id: this.itemId(session), ts: this.now(), kind: "permission_resolved", requestId, allowed: false, by });
    }
    proc.permissions.clear();
  }

  // --- state -----------------------------------------------------------------

  private state(id: string, record?: ChatSessionRecord): ChatSessionState | undefined {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const rec = record ?? this.opts.store.getChatSession(id);
    if (!rec || rec.repoPath !== this.opts.repoPath) return undefined;
    const session: ChatSessionState = { record: rec, status: "idle", reportedModel: null, items: null, proc: null, queued: [], deleted: false, nextItem: 0 };
    this.sessions.set(id, session);
    return session;
  }

  private require(id: string): ChatSessionState {
    const session = this.state(id);
    if (!session) throw new ChatError("not_found", `Chat session ${id} not found`);
    return session;
  }

  /** The item log; loaded from the Claude transcript the first time (sessions from before a restart). */
  private items(session: ChatSessionState): ChatItem[] {
    if (session.items) return session.items;
    const file = session.record.started ? findChatTranscript(this.opts.repoPath, session.record.id, this.env) : null;
    session.items = file ? chatItemsFromTranscript(file, this.opts.repoPath).slice(-MAX_ITEMS) : [];
    return session.items;
  }

  private itemId(session: ChatSessionState): string {
    return `i${this.now().toString(36)}-${++session.nextItem}`;
  }

  private pushItem(session: ChatSessionState, item: ChatItem): void {
    if (session.deleted) return;
    const items = this.items(session);
    items.push(item);
    if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
    this.publish({ type: "chat:item", sessionId: session.record.id, item });
  }

  /** Publishes chat:status (+ chat:session) when the status changes, or always when `force`. */
  private setStatus(session: ChatSessionState, status: ChatStatus, force = false): void {
    if (session.deleted || (session.status === status && !force)) return;
    session.status = status;
    const warning = this.mcpLaunch?.warning;
    this.publish({ type: "chat:status", sessionId: session.record.id, status, ...(warning ? { warning } : {}) });
    this.publishSession(session);
  }

  private publishSession(session: ChatSessionState): void {
    this.publish({ type: "chat:session", session: this.summary(session) });
  }

  private summary(session: ChatSessionState): ChatSessionSummary {
    const { record } = session;
    const model = session.reportedModel ?? record.model;
    return {
      id: record.id,
      title: record.title ?? UNTITLED_CHAT,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: session.status,
      totalCostUsd: record.totalCostUsd,
      ...(model ? { model } : {}),
    };
  }

  private publish(message: ChatMessageBody): void {
    this.opts.bus.emit("chat", { message: { ...message, repoId: this.opts.repoId } as ChatServerMessage });
  }
}

/** First line of the first message, whitespace collapsed, at most CHAT_TITLE_MAX_CHARS. */
export function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim() || UNTITLED_CHAT;
  return line.length <= CHAT_TITLE_MAX_CHARS ? line : `${line.slice(0, CHAT_TITLE_MAX_CHARS - 1)}…`;
}

function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref();
  return timer;
}
