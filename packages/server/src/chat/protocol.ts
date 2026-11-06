import { z } from "zod";

/**
 * Claude Code's stream-json protocol (`claude -p --input-format stream-json --output-format stream-json`),
 * verified against Claude Code 2.1.318 (DESIGN §21.1). Only the fields the chat uses are declared; every
 * schema is loose so unknown fields pass through, and unknown line types are ignored by the normaliser.
 */

const ContentBlockSchema = z.looseObject({ type: z.string() });

export const SystemInitLineSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().optional(),
  model: z.string().optional(),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string().optional() })).optional(),
});

export const StreamEventLineSchema = z.looseObject({
  type: z.literal("stream_event"),
  event: z.looseObject({
    type: z.string(),
    index: z.number().optional(),
    message: z.looseObject({ id: z.string().optional() }).optional(),
    content_block: ContentBlockSchema.optional(),
    delta: z.looseObject({ type: z.string().optional(), text: z.string().optional() }).optional(),
  }),
});

export const AssistantLineSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
  }),
});

export const UserLineSchema = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlockSchema)]).optional() }),
});

export const ResultLineSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  session_id: z.string().optional(),
});

export const ControlRequestLineSchema = z.looseObject({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.looseObject({ subtype: z.string() }),
});

export const CanUseToolRequestSchema = z.looseObject({
  subtype: z.literal("can_use_tool"),
  tool_name: z.string(),
  display_name: z.string().optional(),
  input: z.unknown(),
  description: z.string().optional(),
  blocked_path: z.string().optional(),
  tool_use_id: z.string().optional(),
});

export const ControlResponseLineSchema = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({ subtype: z.string().optional(), request_id: z.string().optional() }),
});

export const TextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
export const ToolUseBlockSchema = z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
export const ToolResultBlockSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

// --- stdin -----------------------------------------------------------------

/** One user turn. */
export function userTurnLine(content: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

export type PermissionDecision = { allow: true; input: unknown } | { allow: false; message: string };

/** Answer to a `can_use_tool` control_request (allow with the unchanged input, or deny with a reason). */
export function permissionResponseLine(requestId: string, decision: PermissionDecision): string {
  const response = decision.allow
    ? { behavior: "allow", updatedInput: decision.input }
    : { behavior: "deny", message: decision.message };
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

/** Error answer to a control_request the chat does not support (so Claude Code does not wait forever). */
export function controlErrorLine(requestId: string, error: string): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
}

/** Stops the current turn; it then ends with a `result` of subtype `error_during_execution`. */
export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
}
