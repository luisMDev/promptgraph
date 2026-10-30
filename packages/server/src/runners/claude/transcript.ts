import type { TokenUsage } from "@promptgraph/shared";

/**
 * Transcript JSONL helpers. Claude Code may write one assistant line per content block, all sharing
 * message.id and the same usage, so usage is deduplicated by message.id.
 */

/** Text of the last assistant message with text content, or null. */
export function lastAssistantText(transcriptPath: string): string | null {
  throw new Error("not implemented");
}

/** Fallback when the Stop payload lacks last_assistant_message: poll until an assistant line exists. */
export function waitForLastAssistantText(transcriptPath: string, timeoutMs?: number): Promise<string | null> {
  throw new Error("not implemented");
}

/** Sum of message.usage over assistant lines (dedup by message.id), costed with costFromUsage. */
export function usageFromTranscript(transcriptPath: string): TokenUsage {
  throw new Error("not implemented");
}
