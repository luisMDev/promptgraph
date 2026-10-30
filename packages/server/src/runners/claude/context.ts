import type { ClaudeNode, CompletionPolicy } from "@promptgraph/shared";
import type { PredecessorOutput } from "../types.js";

/** Max characters of each predecessor output in the context block (§7.5). */
export const CONTEXT_OUTPUT_LIMIT = 4000;

/** Retry of an interrupted Claude node (§8.6). */
export const INTERRUPTED_MESSAGE = "You were interrupted. Continue the task.";

/** Appended to the prompt in marker mode (§7.4). */
export function markerInstruction(token: string): string {
  return `When the task is fully complete, end your final message with ${token}. If you need input, ask instead.`;
}

/**
 * Initial message for a Claude node:
 * - command node: the slash command line itself (context is not prepended);
 * - prompt + "fresh": "Context from previous steps" block (each predecessor's output text, or its
 *   error/exit code/stdout tail for failed ones, truncated to CONTEXT_OUTPUT_LIMIT) + the prompt;
 * - prompt + "clean" / "resume": the prompt only;
 * - completion "marker": markerInstruction appended (prompt nodes only).
 */
export function buildInitialMessage(node: ClaudeNode, predecessors: PredecessorOutput[], completion: CompletionPolicy): string {
  throw new Error("not implemented");
}
