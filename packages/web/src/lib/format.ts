/** Compact duration: "850ms", "42s", "3m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Elapsed time of something that started at `start` and finished at `end` (or is still going at `now`). */
export function elapsed(start: number | null, end: number | null, now: number): string | null {
  if (start === null) return null;
  return formatDuration((end ?? now) - start);
}

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** First line, trimmed to `max` chars with an ellipsis. */
export function preview(text: string | undefined, max = 80): string {
  const line = (text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "owner/repo#12" for GitHub pull request URLs, else the URL itself. */
export function prLabel(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
}
