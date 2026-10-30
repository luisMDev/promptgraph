// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Removes ANSI escape sequences (CSI, OSC, single-char escapes) and carriage returns. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

/** Last `n` lines of `text`. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** Truncates to `max` chars, appending a marker when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
