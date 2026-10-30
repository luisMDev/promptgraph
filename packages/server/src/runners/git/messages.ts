import type { GeneratedMessage, TokenUsage } from "@promptgraph/shared";
import type { PredecessorOutput } from "../types.js";

export interface GenerateMessageInput {
  /** Lane worktree. */
  cwd: string;
  /** "commit" → conventional commit title + body; "pr" → PR title + markdown body. */
  kind: "commit" | "pr";
  /** `git diff --cached --stat` (commit) or `git diff --stat <base>...HEAD` (pr). */
  diffStat: string;
  /** Outputs of the nodes since the last commit in the lane. */
  outputs: PredecessorOutput[];
  model?: string;
  signal?: AbortSignal;
}

/** Headless claude with GENERATED_MESSAGE_JSON_SCHEMA. Falls back to a deterministic message on error. */
export function generateMessage(input: GenerateMessageInput): Promise<GeneratedMessage & { usage: TokenUsage | null }> {
  throw new Error("not implemented");
}
