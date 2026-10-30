import type { ClaudeNode, CompletionPolicy } from "@promptgraph/shared";
import { truncate } from "../../util/text.js";
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
  if (node.type === "command") return node.config.command.trim();
  const parts: string[] = [];
  if (node.config.context === "fresh" && predecessors.length > 0) {
    const blocks = predecessors.map((p) => `### ${p.label || p.nodeId} (${p.type}, ${p.status})\n${truncate(describePredecessor(p), CONTEXT_OUTPUT_LIMIT)}`);
    parts.push(`Context from previous steps:\n\n${blocks.join("\n\n")}\n\n---`);
  }
  parts.push(node.config.prompt.trim());
  if (completion.mode === "marker") parts.push(markerInstruction(completion.token));
  return parts.join("\n\n");
}

/** Plain-text rendering of a predecessor's result for the context block. */
export function describePredecessor(p: PredecessorOutput): string {
  const o = p.output;
  const lines: string[] = [];
  if (p.error) lines.push(`Error: ${p.error}`);
  if (o?.text) lines.push(o.text);
  if (o?.exitCode !== undefined) lines.push(`Exit code: ${o.exitCode ?? "none"}${o.timedOut ? " (timed out)" : ""}`);
  if (o?.stdoutTail) lines.push(`Output (tail):\n${o.stdoutTail}`);
  if (o?.noop) lines.push("Nothing to commit.");
  if (o?.sha) lines.push(`Commit ${o.sha}${o.message ? `: ${o.message}` : ""}`);
  if (o?.prUrl) lines.push(`Pull request: ${o.prUrl}`);
  if (o?.approved !== undefined) lines.push(`${o.approved ? "Approved" : "Rejected"}${o.comment ? `: ${o.comment}` : ""}`);
  return lines.length > 0 ? lines.join("\n") : "(no output)";
}
