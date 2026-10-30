import { z } from "zod";
import type { NodeType } from "../graph.js";

export const VALIDATION_CODES = [
  // errors
  "empty_graph",
  "duplicate_node_id",
  "duplicate_edge_id",
  "dangling_edge",
  "self_loop",
  "duplicate_edge",
  "invalid_port",
  "cycle",
  "invalid_join",
  "merge_input_count",
  "invalid_resume_context",
  "missing_config",
  "invalid_config",
  "invalid_loop",
  "pr_requires_approval",
  "phase2_unsupported",
  "unsupported_node_type",
  // warnings
  "uncommitted_before_pr",
  "uncommitted_before_merge",
  "empty_label",
  "condition_input",
] as const;
export const ValidationCodeSchema = z.enum(VALIDATION_CODES);
export type ValidationCode = z.infer<typeof ValidationCodeSchema>;

export const ValidationIssueSchema = z.object({
  code: ValidationCodeSchema,
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Only `errors` block running (Run button disabled); `warnings` are informational. */
export const ValidationResultSchema = z.object({
  errors: z.array(ValidationIssueSchema),
  warnings: z.array(ValidationIssueSchema),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export interface ValidateOptions {
  /**
   * 1: conditions, failure edges and loops are rejected (`phase2_unsupported`) and every non-merge
   * multi-input node is invalid. 2: Phase 2 rules (§15). Default 2. The server passes the phase its
   * engine supports.
   */
  phase?: 1 | 2;
  /**
   * Node types the engine can run (`unsupported_node_type` error for others). Default: every type.
   * The server passes its runner registry's types until all milestones land.
   */
  supportedNodeTypes?: readonly NodeType[];
}
