import fs from "node:fs";
import { accumulateUsage, emptyUsage, type RawUsage, type TokenUsage } from "@promptgraph/shared";

/**
 * Transcript JSONL helpers. Claude Code may write one assistant line per content block, all sharing
 * message.id and the same usage, so usage is deduplicated by message.id.
 */

interface TranscriptLine {
  type?: string;
  message?: {
    id?: string;
    model?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    usage?: RawUsage;
  };
}

/** Model Claude Code uses for locally generated assistant messages (no API call, no cost). */
const SYNTHETIC_MODEL = "<synthetic>";
const POLL_MS = 100;

function readLines(transcriptPath: string): TranscriptLine[] {
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const lines: TranscriptLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as TranscriptLine);
    } catch {
      // Partially written last line.
    }
  }
  return lines;
}

function textOf(line: TranscriptLine): string | null {
  const content = line.message?.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  return text.trim() ? text : null;
}

/** Text of the last assistant message with text content, or null. */
export function lastAssistantText(transcriptPath: string): string | null {
  const lines = readLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.type !== "assistant") continue;
    const text = textOf(line);
    if (text) return text;
  }
  return null;
}

/** True when the last conversational line is an assistant message with text (the turn is written). */
function turnWritten(transcriptPath: string): boolean {
  const lines = readLines(transcriptPath).filter((l) => l.type === "user" || l.type === "assistant");
  const last = lines[lines.length - 1];
  return !!last && last.type === "assistant" && textOf(last) !== null;
}

/** Fallback when the Stop payload lacks last_assistant_message: poll until an assistant line exists. */
export async function waitForLastAssistantText(transcriptPath: string, timeoutMs = 3000): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (!turnWritten(transcriptPath) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return lastAssistantText(transcriptPath);
}

/** message.ids of the assistant lines already in a transcript (the usage baseline of a resumed session). */
export function assistantMessageIds(transcriptPath: string): Set<string> {
  const ids = new Set<string>();
  for (const line of readLines(transcriptPath)) {
    if (line.type === "assistant" && line.message?.id) ids.add(line.message.id);
  }
  return ids;
}

/**
 * Sum of message.usage over assistant lines (dedup by message.id), costed with costFromUsage.
 * `exclude`: ids present before this node started (`--resume` appends to the same transcript, so the
 * earlier usage belongs to the predecessor or previous attempt and is already counted there).
 */
export function usageFromTranscript(transcriptPath: string, exclude: ReadonlySet<string> = new Set()): TokenUsage {
  const seen = new Set<string>(exclude);
  let usage = emptyUsage();
  for (const line of readLines(transcriptPath)) {
    const message = line.message;
    if (line.type !== "assistant" || !message?.usage || message.model === SYNTHETIC_MODEL) continue;
    if (message.id) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
    }
    usage = accumulateUsage(usage, message.model, message.usage);
  }
  return usage;
}
