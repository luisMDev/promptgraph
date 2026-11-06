import { NODE_TYPES, sanitizeKeyterms, type Graph } from "@promptgraph/shared";

/**
 * Words that bias whisper towards the vocabulary on screen (sent as voice:start `keyterms`, whisper `--prompt`):
 * "promptgraph", the node type names and the labels of the open graph's nodes. Sanitised and capped by the shared
 * helper (VOICE_MAX_KEYTERMS, VOICE_MAX_KEYTERM_LENGTH).
 */
export function dictationKeyterms(graph: Graph | null | undefined): string[] {
  // Labels only: node ids ("b", "n3") are not words anyone dictates.
  const labels = graph ? graph.nodes.map((n) => n.label?.trim() ?? "") : [];
  return sanitizeKeyterms(["promptgraph", ...NODE_TYPES, ...labels]);
}
