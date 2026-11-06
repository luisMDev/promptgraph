import path from "node:path";
import {
  CHAT_TOOL_RESULT_MAX_CHARS,
  shortToolName,
  type ChatItem,
  type ChatItemOf,
  type ChatPermissionRequestItem,
} from "@promptgraph/shared";
import {
  AssistantLineSchema,
  CanUseToolRequestSchema,
  ControlRequestLineSchema,
  ControlResponseLineSchema,
  RateLimitEventLineSchema,
  ResultLineSchema,
  type RateLimitInfo,
  StreamEventLineSchema,
  SystemInitLineSchema,
  TextBlockSchema,
  ToolResultBlockSchema,
  ToolUseBlockSchema,
  UserLineSchema,
} from "./protocol.js";

/** What one stream-json line means for the chat. A line yields zero or more events. */
export type ChatEvent =
  | { kind: "item"; item: ChatItem }
  | { kind: "delta"; messageId: string; text: string }
  | { kind: "init"; sessionId?: string; model?: string }
  | { kind: "permission"; item: ChatPermissionRequestItem }
  | { kind: "result"; item: ChatItemOf<"result">; totalCostUsd?: number }
  /** A control_request the chat cannot answer: the manager replies with an error. */
  | { kind: "unsupported_control"; requestId: string; subtype: string }
  | { kind: "control_response"; requestId?: string }
  /** Subscription usage limits (§23.3); not shown in the transcript. */
  | { kind: "rate_limit"; info: RateLimitInfo };

export interface NormalizerOptions {
  /** Unique item ids within the session. */
  newId: () => string;
  now?: () => number;
  /** Paths under this dir are shown relative to it in tool summaries. */
  cwd?: string;
}

/** Names the promptgraph MCP server has in system/init: via the plugin, or via --mcp-config. */
export const PROMPTGRAPH_MCP_SERVER_NAMES: readonly string[] = ["plugin:promptgraph:promptgraph", "promptgraph"];
/** MCP statuses worth a notice ("pending" at init is normal: the server is still starting). */
const FAILED_MCP_STATUSES = new Set(["failed", "needs-auth"]);
const SUMMARY_MAX_CHARS = 120;

/**
 * Turns raw stream-json lines (DESIGN §21.6) into chat events. Stateful per Claude Code process: it
 * pairs streamed text deltas with the final assistant text blocks. Text block `k` (0-based, counting
 * text blocks only) of API message `m` has messageId `m#k` in both chat:delta and the assistant item.
 * Unknown or malformed lines yield nothing.
 */
export class ChatNormalizer {
  private readonly now: () => number;
  private initSeen = false;
  /** Current streamed message: id and content-block index → text ordinal. */
  private streamMessageId: string | null = null;
  private streamTextOrdinals = new Map<number, number>();
  /** Text blocks already emitted per message (assistant lines may carry one block each). */
  private readonly assistantTextCount = new Map<string, number>();
  private anonymousMessages = 0;

  constructor(private readonly opts: NormalizerOptions) {
    this.now = opts.now ?? Date.now;
  }

  handle(line: unknown): ChatEvent[] {
    if (!line || typeof line !== "object") return [];
    switch ((line as { type?: unknown }).type) {
      case "system":
        return this.system(line);
      case "stream_event":
        return this.streamEvent(line);
      case "assistant":
        return this.assistant(line);
      case "user":
        return this.user(line);
      case "result":
        return this.result(line);
      case "control_request":
        return this.controlRequest(line);
      case "rate_limit_event": {
        const parsed = RateLimitEventLineSchema.safeParse(line);
        return parsed.success ? [{ kind: "rate_limit", info: parsed.data.rate_limit_info }] : [];
      }
      case "control_response": {
        const parsed = ControlResponseLineSchema.safeParse(line);
        return parsed.success ? [{ kind: "control_response", requestId: parsed.data.response.request_id }] : [];
      }
      default:
        return [];
    }
  }

  private base<K extends ChatItem["kind"]>(kind: K): { id: string; ts: number; kind: K } {
    return { id: this.opts.newId(), ts: this.now(), kind };
  }

  private system(line: unknown): ChatEvent[] {
    const parsed = SystemInitLineSchema.safeParse(line);
    if (!parsed.success) return [];
    const init = parsed.data;
    const events: ChatEvent[] = [{ kind: "init", sessionId: init.session_id, model: init.model }];
    if (this.initSeen) return events;
    this.initSeen = true;
    if (init.mcp_servers) {
      const server = init.mcp_servers.find((s) => PROMPTGRAPH_MCP_SERVER_NAMES.includes(s.name));
      if (!server) {
        events.push({ kind: "item", item: { ...this.base("notice"), text: "The promptgraph MCP server is not loaded: graph tools are unavailable" } });
      } else if (server.status && FAILED_MCP_STATUSES.has(server.status)) {
        events.push({
          kind: "item",
          item: { ...this.base("notice"), text: `MCP server ${server.name} failed to connect (${server.status}): graph tools are unavailable` },
        });
      }
    }
    return events;
  }

  private streamEvent(line: unknown): ChatEvent[] {
    const parsed = StreamEventLineSchema.safeParse(line);
    if (!parsed.success) return [];
    const event = parsed.data.event;
    switch (event.type) {
      case "message_start":
        this.streamMessageId = event.message?.id ?? `anon-${++this.anonymousMessages}`;
        this.streamTextOrdinals = new Map();
        return [];
      case "content_block_start":
        if (event.content_block?.type === "text" && event.index !== undefined) {
          this.streamTextOrdinals.set(event.index, this.streamTextOrdinals.size);
        }
        return [];
      case "content_block_delta": {
        if (event.delta?.type !== "text_delta" || !event.delta.text || !this.streamMessageId || event.index === undefined) return [];
        let ordinal = this.streamTextOrdinals.get(event.index);
        if (ordinal === undefined) {
          ordinal = this.streamTextOrdinals.size;
          this.streamTextOrdinals.set(event.index, ordinal);
        }
        return [{ kind: "delta", messageId: `${this.streamMessageId}#${ordinal}`, text: event.delta.text }];
      }
      default:
        return [];
    }
  }

  private assistant(line: unknown): ChatEvent[] {
    const parsed = AssistantLineSchema.safeParse(line);
    if (!parsed.success) return [];
    const { message } = parsed.data;
    const messageId = message.id ?? this.streamMessageId ?? `anon-${++this.anonymousMessages}`;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
    const events: ChatEvent[] = [];
    for (const block of blocks) {
      const text = TextBlockSchema.safeParse(block);
      if (text.success) {
        const ordinal = this.assistantTextCount.get(messageId) ?? 0;
        this.assistantTextCount.set(messageId, ordinal + 1);
        if (!text.data.text.trim()) continue;
        events.push({ kind: "item", item: { ...this.base("assistant"), messageId: `${messageId}#${ordinal}`, text: text.data.text } });
        continue;
      }
      const tool = ToolUseBlockSchema.safeParse(block);
      if (tool.success) {
        const { id, name, input } = tool.data;
        events.push({
          kind: "item",
          item: { ...this.base("tool_use"), toolUseId: id, name, input, summary: summarizeToolUse(name, input, this.opts.cwd) },
        });
      }
      // thinking, redacted_thinking, server tool blocks: not shown.
    }
    return events;
  }

  private user(line: unknown): ChatEvent[] {
    const parsed = UserLineSchema.safeParse(line);
    if (!parsed.success || !Array.isArray(parsed.data.message.content)) return [];
    const events: ChatEvent[] = [];
    for (const block of parsed.data.message.content) {
      const result = ToolResultBlockSchema.safeParse(block);
      if (!result.success) continue;
      events.push({
        kind: "item",
        item: {
          ...this.base("tool_result"),
          toolUseId: result.data.tool_use_id,
          isError: result.data.is_error === true,
          text: truncateToolResult(toolResultText(result.data.content)),
        },
      });
    }
    return events;
  }

  private result(line: unknown): ChatEvent[] {
    const parsed = ResultLineSchema.safeParse(line);
    if (!parsed.success) return [];
    const r = parsed.data;
    const item: ChatItemOf<"result"> = {
      ...this.base("result"),
      subtype: r.subtype,
      isError: r.is_error ?? r.subtype !== "success",
      ...(r.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}),
    };
    return [{ kind: "result", item, ...(r.total_cost_usd !== undefined ? { totalCostUsd: r.total_cost_usd } : {}) }];
  }

  private controlRequest(line: unknown): ChatEvent[] {
    const parsed = ControlRequestLineSchema.safeParse(line);
    if (!parsed.success) return [];
    const { request_id: requestId, request } = parsed.data;
    const tool = CanUseToolRequestSchema.safeParse(request);
    if (!tool.success) return [{ kind: "unsupported_control", requestId, subtype: request.subtype }];
    const t = tool.data;
    const item: ChatPermissionRequestItem = {
      ...this.base("permission_request"),
      requestId,
      toolName: t.tool_name,
      input: t.input ?? {},
      ...(t.display_name ? { displayName: t.display_name } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.blocked_path ? { blockedPath: t.blocked_path } : {}),
    };
    return [{ kind: "permission", item }];
  }
}

/** Text of a tool_result `content` (string, or blocks of which only text is kept). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((block: unknown) => {
      const text = TextBlockSchema.safeParse(block);
      if (text.success) return text.data.text;
      const type = (block as { type?: unknown } | null)?.type;
      return typeof type === "string" ? `[${type}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

const TRUNCATION_MARK = "\n…[truncated]";

/** At most CHAT_TOOL_RESULT_MAX_CHARS characters, marker included. */
export function truncateToolResult(text: string): string {
  if (text.length <= CHAT_TOOL_RESULT_MAX_CHARS) return text;
  return text.slice(0, CHAT_TOOL_RESULT_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

function oneLine(text: string, max = SUMMARY_MAX_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function displayPath(p: string, cwd?: string): string {
  if (!cwd || !path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

/** Keys of promptgraph tool arguments worth showing, in order. */
const PG_ID_KEYS = ["graphId", "id", "runId", "nodeRunId", "nodeId"];

/** One line for a collapsed tool row, e.g. "Read src/app.ts", "patch_graph landing · 2 ops". */
export function summarizeToolUse(name: string, input: unknown, cwd?: string): string {
  const short = shortToolName(name);
  const filePath = str(input, "file_path") ?? str(input, "notebook_path");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return oneLine(filePath ? `${name} ${displayPath(filePath, cwd)}` : name);
    case "Grep": {
      const pattern = str(input, "pattern");
      const where = str(input, "path") ?? str(input, "glob");
      return oneLine(`Grep${pattern ? ` "${pattern}"` : ""}${where ? ` in ${displayPath(where, cwd)}` : ""}`);
    }
    case "Glob":
      return oneLine(`Glob ${str(input, "pattern") ?? ""}`);
    case "LS":
      return oneLine(`LS ${displayPath(str(input, "path") ?? ".", cwd)}`);
    case "Bash":
      return oneLine(`Bash: ${str(input, "command") ?? ""}`);
    case "WebFetch":
      return oneLine(`WebFetch ${str(input, "url") ?? ""}`);
    case "WebSearch":
      return oneLine(`WebSearch ${str(input, "query") ?? ""}`);
    case "Task":
    case "Agent":
      return oneLine(`${name}: ${str(input, "description") ?? ""}`);
    case "Skill":
      return oneLine(`Skill ${str(input, "skill") ?? str(input, "command") ?? ""}`);
    case "TodoWrite": {
      const todos = (input as { todos?: unknown } | null)?.todos;
      return Array.isArray(todos) ? `TodoWrite · ${todos.length} todos` : "TodoWrite";
    }
  }
  if (short === name) return oneLine(name);
  // MCP tool.
  const id = PG_ID_KEYS.map((k) => str(input, k)).find(Boolean);
  const graph = (input as { graph?: { id?: unknown } } | null)?.graph;
  const graphId = id ?? (typeof graph?.id === "string" ? graph.id : undefined);
  const ops = (input as { ops?: unknown } | null)?.ops;
  const parts = [graphId ? `${short} ${graphId}` : short];
  if (Array.isArray(ops)) parts.push(`${ops.length} op${ops.length === 1 ? "" : "s"}`);
  return oneLine(parts.join(" · "));
}
