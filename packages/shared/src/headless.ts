import { z } from "zod";

/**
 * Envelope printed by `claude -p --output-format json [--json-schema <schema>]` (verified against
 * Claude Code 2.1.314). Only the fields promptgraph uses are declared; the rest are kept.
 *
 * - `result` is the final text (with --json-schema: the JSON serialised as a string).
 * - `structured_output` is the parsed object matching --json-schema (absent without it).
 * - `usage` has the same shape as transcript `message.usage`; `modelUsage` is keyed by model id.
 */
export const HeadlessResultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(), // "success" | "error_max_turns" | "error_during_execution" | …
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  session_id: z.string(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
  modelUsage: z.record(z.string(), z.looseObject({ costUSD: z.number().optional() })).optional(),
});
export type HeadlessResult = z.infer<typeof HeadlessResultSchema>;

/** --json-schema used for generated commit messages and PR title/body. */
export const GeneratedMessageSchema = z.object({ title: z.string(), body: z.string() });
export type GeneratedMessage = z.infer<typeof GeneratedMessageSchema>;
export const GENERATED_MESSAGE_JSON_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

/** --json-schema used by the Phase 2 judge evaluator. */
export const JudgeVerdictSchema = z.object({ pass: z.boolean(), reason: z.string() });
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;
export const JUDGE_JSON_SCHEMA = {
  type: "object",
  properties: { pass: { type: "boolean" }, reason: { type: "string" } },
  required: ["pass", "reason"],
  additionalProperties: false,
} as const;
