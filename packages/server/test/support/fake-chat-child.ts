import type { ChatChild, ChatChildExit, ChatSpawner, ChatSpawnSpec } from "../../src/chat/process.js";

/** In-memory stand-in for a `claude -p --input-format stream-json` process (never spawns anything). */
export class FakeChatChild implements ChatChild {
  readonly pid = 4242;
  /** Lines written to stdin (without the trailing newline). */
  readonly written: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  stdinOpen = true;
  exited = false;
  private readonly stdout: Array<(chunk: Buffer | string) => void> = [];
  private readonly stderr: Array<(chunk: Buffer | string) => void> = [];
  private readonly exits: Array<(exit: ChatChildExit) => void> = [];

  constructor(readonly spec: ChatSpawnSpec) {}

  writeLine(line: string): boolean {
    if (!this.stdinOpen) return false;
    this.written.push(line);
    return true;
  }
  endInput(): void {
    this.stdinOpen = false;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal);
  }
  onStdout(l: (chunk: Buffer | string) => void): void {
    this.stdout.push(l);
  }
  onStderr(l: (chunk: Buffer | string) => void): void {
    this.stderr.push(l);
  }
  onExit(l: (exit: ChatChildExit) => void): void {
    this.exits.push(l);
  }

  /** stdin lines parsed as JSON. */
  get writtenJson(): unknown[] {
    return this.written.map((l) => JSON.parse(l) as unknown);
  }

  /** Emits NDJSON lines on stdout (as one chunk). */
  emit(...lines: unknown[]): void {
    const chunk = lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join("");
    for (const l of this.stdout) l(Buffer.from(chunk));
  }
  emitStderr(text: string): void {
    for (const l of this.stderr) l(Buffer.from(text));
  }
  exit(exit: Partial<ChatChildExit> = {}): void {
    if (this.exited) return;
    this.exited = true;
    this.stdinOpen = false;
    for (const l of this.exits) l({ code: 0, signal: null, ...exit });
  }
}

/** Spawner that records every child it "starts". */
export function fakeSpawner(): { spawner: ChatSpawner; children: FakeChatChild[]; last(): FakeChatChild } {
  const children: FakeChatChild[] = [];
  return {
    children,
    spawner: (spec) => {
      const child = new FakeChatChild(spec);
      children.push(child);
      return child;
    },
    last: () => {
      const child = children[children.length - 1];
      if (!child) throw new Error("no chat child spawned");
      return child;
    },
  };
}

// --- recorded stream-json lines (shapes verified against Claude Code 2.1.318) -------------------

export const initLine = (sessionId: string, mcpStatus = "connected", name = "plugin:promptgraph:promptgraph") => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "claude-sonnet-4-5",
  cwd: "/repo",
  tools: ["Read", "Grep"],
  mcp_servers: [{ name, status: mcpStatus }],
  permissionMode: "default",
  claude_code_version: "2.1.318",
});

export const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event, session_id: "s", uuid: "u" });

export const textTurn = (messageId: string, chunks: string[]) => [
  streamEvent({ type: "message_start", message: { id: messageId, role: "assistant", content: [] } }),
  streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ...chunks.map((text) => streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
  streamEvent({ type: "content_block_stop", index: 0 }),
  { type: "assistant", message: { id: messageId, role: "assistant", content: [{ type: "text", text: chunks.join("") }] } },
  streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  streamEvent({ type: "message_stop" }),
];

export const resultLine = (subtype = "success", totalCostUsd = 0.01, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype,
  is_error: subtype !== "success",
  result: "done",
  total_cost_usd: totalCostUsd,
  duration_ms: 1200,
  session_id: "s",
  permission_denials: [],
  ...extra,
});
