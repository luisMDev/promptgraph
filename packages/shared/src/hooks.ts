import { z } from "zod";

/** URL segment of POST /hooks/:nodeRunId/:event, i.e. the argument passed to pg-hook. */
export const HOOK_EVENTS = ["session-start", "activity", "notification", "stop"] as const;
export const HookEventSchema = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEventSchema>;

/** Claude Code hook names mapped to pg-hook arguments (hooks.json generation). */
export const CLAUDE_HOOK_FOR_EVENT: Readonly<Record<HookEvent, string>> = {
  "session-start": "SessionStart",
  activity: "PreToolUse",
  notification: "Notification",
  stop: "Stop",
};

// Payloads (validated in SPIKE.md against Claude Code 2.1.x). Unknown fields are kept (loose).

export const SessionStartPayloadSchema = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  source: z.string().optional(), // "startup" | "resume" | "clear" | "compact"
  model: z.string().optional(),
  cwd: z.string().optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const PreToolUsePayloadSchema = z.looseObject({
  session_id: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
});
export type PreToolUsePayload = z.infer<typeof PreToolUsePayloadSchema>;

export const NotificationPayloadSchema = z.looseObject({
  session_id: z.string().optional(),
  message: z.string().default(""),
  notification_type: z.string().optional(), // e.g. "permission_prompt", "idle_prompt"
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

export const StopPayloadSchema = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  /** Present in Claude Code ≥ 2.1 (SPIKE A3). Fallback: read transcript_path. */
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});
export type StopPayload = z.infer<typeof StopPayloadSchema>;

export const HOOK_PAYLOAD_SCHEMAS = {
  "session-start": SessionStartPayloadSchema,
  activity: PreToolUsePayloadSchema,
  notification: NotificationPayloadSchema,
  stop: StopPayloadSchema,
} as const satisfies Record<HookEvent, z.ZodType>;

export type HookPayloadMap = { [K in HookEvent]: z.infer<(typeof HOOK_PAYLOAD_SCHEMAS)[K]> };

/** "Bash: pnpm test", "Edit: src/app.ts", or just the tool name. Truncated to 120 chars. */
export function describeToolActivity(p: Pick<PreToolUsePayload, "tool_name" | "tool_input">): string {
  const input = p.tool_input ?? {};
  const pick = ["command", "file_path", "path", "pattern", "url", "description", "prompt"]
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const text = pick ? `${p.tool_name}: ${pick.replace(/\s+/g, " ")}` : p.tool_name;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
