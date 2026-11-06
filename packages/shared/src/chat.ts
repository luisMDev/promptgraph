import { z } from "zod";

/**
 * In-app Claude Code chat (DESIGN §20). The server runs one background `claude -p --input-format
 * stream-json` process per active chat session in the repository's main checkout and normalises its
 * structured output into `ChatItem`s; the web UI renders those items and streams text via `chat:delta`.
 */

// --- Status ----------------------------------------------------------------

export const CHAT_STATUSES = ["idle", "starting", "thinking", "waiting_permission", "exited", "error"] as const;
export const ChatStatusSchema = z.enum(CHAT_STATUSES);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

// --- Items -----------------------------------------------------------------

const itemBase = {
  /** Unique within the session. */
  id: z.string(),
  /** Epoch ms. */
  ts: z.number(),
};

/** Maximum length of `tool_result.text`; longer results are truncated by the server. */
export const CHAT_TOOL_RESULT_MAX_CHARS = 2000;

export const ChatUserItemSchema = z.object({ ...itemBase, kind: z.literal("user"), text: z.string() });
/** Final text of one assistant text block (streamed before via chat:delta with the same messageId). */
export const ChatAssistantItemSchema = z.object({ ...itemBase, kind: z.literal("assistant"), messageId: z.string(), text: z.string() });
export const ChatToolUseItemSchema = z.object({
  ...itemBase,
  kind: z.literal("tool_use"),
  toolUseId: z.string(),
  /** Full tool name as Claude Code reports it, e.g. "Read" or "mcp__plugin_promptgraph_promptgraph__patch_graph". */
  name: z.string(),
  input: z.unknown(),
  /** One line for the collapsed row, e.g. "Read src/app.ts", "patch_graph · 2 ops". */
  summary: z.string(),
});
export const ChatToolResultItemSchema = z.object({
  ...itemBase,
  kind: z.literal("tool_result"),
  toolUseId: z.string(),
  isError: z.boolean(),
  /** Truncated to CHAT_TOOL_RESULT_MAX_CHARS. */
  text: z.string(),
});
export const ChatPermissionRequestItemSchema = z.object({
  ...itemBase,
  kind: z.literal("permission_request"),
  /** Claude Code's control_request id, echoed back in chat:permission. */
  requestId: z.string(),
  toolName: z.string(),
  displayName: z.string().optional(),
  input: z.unknown(),
  description: z.string().optional(),
  blockedPath: z.string().optional(),
});
export const ChatPermissionResolvedItemSchema = z.object({
  ...itemBase,
  kind: z.literal("permission_resolved"),
  requestId: z.string(),
  allowed: z.boolean(),
  /** "interrupt": the turn was stopped while waiting; "exit": the process ended while waiting. */
  by: z.enum(["user", "interrupt", "exit"]),
});
/** End of a turn (stream-json `result`). */
export const ChatResultItemSchema = z.object({
  ...itemBase,
  kind: z.literal("result"),
  /** "success", "error_during_execution", "error_max_turns", … as reported by Claude Code. */
  subtype: z.string(),
  isError: z.boolean(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
});
export const ChatErrorItemSchema = z.object({ ...itemBase, kind: z.literal("error"), message: z.string() });
/** Informational line, e.g. "MCP server promptgraph failed to connect". */
export const ChatNoticeItemSchema = z.object({ ...itemBase, kind: z.literal("notice"), text: z.string() });

export const ChatItemSchema = z.discriminatedUnion("kind", [
  ChatUserItemSchema,
  ChatAssistantItemSchema,
  ChatToolUseItemSchema,
  ChatToolResultItemSchema,
  ChatPermissionRequestItemSchema,
  ChatPermissionResolvedItemSchema,
  ChatResultItemSchema,
  ChatErrorItemSchema,
  ChatNoticeItemSchema,
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;
export type ChatItemKind = ChatItem["kind"];
export type ChatItemOf<K extends ChatItemKind> = Extract<ChatItem, { kind: K }>;
export type ChatPermissionRequestItem = z.infer<typeof ChatPermissionRequestItemSchema>;

// --- Sessions --------------------------------------------------------------

export const ChatSessionSummarySchema = z.object({
  /** The Claude Code session id (pre-generated UUID, passed as --session-id / --resume). */
  id: z.string(),
  /** First user message, truncated (CHAT_TITLE_MAX_CHARS). */
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: ChatStatusSchema,
  totalCostUsd: z.number(),
  model: z.string().optional(),
});
export type ChatSessionSummary = z.infer<typeof ChatSessionSummarySchema>;

export const CHAT_TITLE_MAX_CHARS = 80;

export const ChatSessionDetailSchema = z.object({
  session: ChatSessionSummarySchema,
  items: z.array(ChatItemSchema),
  /** Every permission prompt Claude is waiting on, oldest first (parallel tool calls may open several). */
  pendingPermissions: z.array(ChatPermissionRequestItemSchema),
  /**
   * Text streamed so far for assistant messages whose final item has not arrived yet (in arrival order), so a
   * client opening the session or reconnecting mid-stream shows the whole text, not only the later deltas.
   */
  streaming: z.array(z.object({ messageId: z.string(), text: z.string() })),
});
export type ChatSessionDetail = z.infer<typeof ChatSessionDetailSchema>;

// --- Per-message UI context ------------------------------------------------

/** What the user is looking at when sending a message; the server turns it into a <promptgraph-context> block. */
export const ChatContextSchema = z.object({
  graphId: z.string().nullable(),
  graphName: z.string().optional(),
  selectedNodeIds: z.array(z.string()),
  selectedEdgeIds: z.array(z.string()),
  runId: z.string().nullable(),
  /** The graph on screen is read-only (a run is active or a historical run is shown). */
  readOnly: z.boolean(),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;

export const EMPTY_CHAT_CONTEXT: ChatContext = { graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: null, readOnly: false };

/** Escapes a value for a double-quoted XML-like attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n|\r/g, "&#10;");
}

/**
 * `<promptgraph-context graph="<id>" [graph-name="…"] selected-nodes="n1,n2" selected-edges="" run="none" read-only="false" />`.
 * Absent graph / run are written as "none". Pure; every attribute value is escaped.
 */
export function buildChatContextBlock(context: ChatContext): string {
  const attrs: [string, string][] = [["graph", context.graphId ?? "none"]];
  if (context.graphName) attrs.push(["graph-name", context.graphName]);
  attrs.push(
    ["selected-nodes", context.selectedNodeIds.join(",")],
    ["selected-edges", context.selectedEdgeIds.join(",")],
    ["run", context.runId ?? "none"],
    ["read-only", String(context.readOnly)],
  );
  return `<promptgraph-context ${attrs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ")} />`;
}

/** The user content sent to Claude: the context block, a blank line, then the user's text. */
export function withChatContext(context: ChatContext, text: string): string {
  return `${buildChatContextBlock(context)}\n\n${text}`;
}

/** Inverse of withChatContext, for history rebuilt from a transcript: drops a leading context block. */
export function stripChatContext(content: string): string {
  const match = /^<promptgraph-context\b[^>]*\/>\r?\n(?:\r?\n)?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

// --- Tool names ------------------------------------------------------------

/** Prefixes of the promptgraph MCP tools: via the plugin (--plugin-dir) and via the --mcp-config fallback. */
export const PROMPTGRAPH_MCP_TOOL_PREFIXES = ["mcp__plugin_promptgraph_promptgraph__", "mcp__promptgraph__"] as const;

/** "mcp__plugin_promptgraph_promptgraph__patch_graph" → "patch_graph"; other MCP tools → "<server>/<tool>"; built-ins unchanged. */
export function shortToolName(name: string): string {
  for (const prefix of PROMPTGRAPH_MCP_TOOL_PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]}/${mcp[2]}` : name;
}

// --- REST ------------------------------------------------------------------

/** GET /api/chat/sessions (most recently updated first) */
export const ListChatSessionsResponseSchema = z.object({ sessions: z.array(ChatSessionSummarySchema) });
export type ListChatSessionsResponse = z.infer<typeof ListChatSessionsResponseSchema>;

/** POST /api/chat/sessions — creates the session metadata; the process starts on the first chat:send. */
export const CreateChatSessionRequestSchema = z.object({ model: z.string().min(1).optional() });
export type CreateChatSessionRequest = z.infer<typeof CreateChatSessionRequestSchema>;
export const CreateChatSessionResponseSchema = z.object({ session: ChatSessionSummarySchema });
export type CreateChatSessionResponse = z.infer<typeof CreateChatSessionResponseSchema>;

/** GET /api/chat/sessions/:id */
export const GetChatSessionResponseSchema = ChatSessionDetailSchema;
export type GetChatSessionResponse = z.infer<typeof GetChatSessionResponseSchema>;

/** DELETE /api/chat/sessions/:id → OkResponse (kills the process; Claude's transcript stays on disk). */

// --- WebSocket payloads (members of the unions in ws.ts) --------------------

export const ChatSendMessageSchema = z.object({
  type: z.literal("chat:send"),
  sessionId: z.string(),
  text: z.string().min(1),
  context: ChatContextSchema,
});
export const ChatInterruptMessageSchema = z.object({ type: z.literal("chat:interrupt"), sessionId: z.string() });
export const ChatPermissionMessageSchema = z.object({
  type: z.literal("chat:permission"),
  sessionId: z.string(),
  requestId: z.string(),
  allow: z.boolean(),
  /** Deny reason shown to Claude. */
  message: z.string().optional(),
});

export const ChatItemMessageSchema = z.object({ type: z.literal("chat:item"), sessionId: z.string(), item: ChatItemSchema });
/**
 * A streamed text_delta chunk of the assistant message `messageId`; the final chat:item replaces the deltas.
 * `offset` is the length of the text streamed before this chunk, so a client that loaded the partial text from
 * ChatSessionDetail.streaming can join the two without gaps or duplicates.
 */
export const ChatDeltaMessageSchema = z.object({
  type: z.literal("chat:delta"),
  sessionId: z.string(),
  messageId: z.string(),
  text: z.string(),
  offset: z.number().int().nonnegative(),
});
export const ChatStatusMessageSchema = z.object({
  type: z.literal("chat:status"),
  sessionId: z.string(),
  status: ChatStatusSchema,
  /** e.g. "promptgraph plugin not found: MCP tools only, no skills". */
  warning: z.string().optional(),
});
/** A session was created or its metadata changed (title, cost, status, …). */
export const ChatSessionMessageSchema = z.object({ type: z.literal("chat:session"), session: ChatSessionSummarySchema });
export const ChatDeletedMessageSchema = z.object({ type: z.literal("chat:deleted"), sessionId: z.string() });
