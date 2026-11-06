/**
 * Web routes shared by the web app, the CLI, `promptgraph mcp` and the desktop shell (DESIGN §13.2), so
 * every producer builds the links the web router parses. Every dynamic segment is encodeURIComponent'd.
 */
const enc = encodeURIComponent;

export const webRoutes = {
  home: (): string => "/",
  repo: (repoId: string): string => `/r/${enc(repoId)}`,
  graph: (repoId: string, graphId: string): string => `/r/${enc(repoId)}/graphs/${enc(graphId)}`,
  run: (repoId: string, runId: string): string => `/r/${enc(repoId)}/runs/${enc(runId)}`,
  nodeRun: (repoId: string, runId: string, nodeRunId: string): string =>
    `/r/${enc(repoId)}/runs/${enc(runId)}/nodes/${enc(nodeRunId)}`,
  report: (repoId: string, runId: string): string => `/r/${enc(repoId)}/runs/${enc(runId)}/report`,
} as const;

/** Served by the daemon, never by the web router (DESIGN §14). */
export const LOGIN_PATH = "/login";

/**
 * Canonical form of a path, the tab dedupe key (DESIGN §13.4): no trailing slash (except `/` itself) and
 * canonical percent-encoding (every segment re-encoded with encodeURIComponent(decodeURIComponent(seg));
 * a segment that does not decode is kept as is). A query or fragment is kept unchanged.
 */
export function normalizePath(p: string): string {
  const cut = p.search(/[?#]/);
  const pathname = cut === -1 ? p : p.slice(0, cut);
  const suffix = cut === -1 ? "" : p.slice(cut);
  const segments = pathname.split("/").map((seg) => {
    try {
      return encodeURIComponent(decodeURIComponent(seg));
    } catch {
      return seg;
    }
  });
  let out = segments.join("/");
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  if (!out.startsWith("/")) out = `/${out}`;
  return out + suffix;
}

// Control characters (C0, DEL, C1) and any whitespace, including Unicode spaces.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\s]/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A `next` target a login may redirect to: starts with exactly one `/` (no `//` protocol-relative
 * prefix), contains no backslash (browsers treat `/\` like `//`), no control character, no whitespace
 * and no scheme.
 */
export function isSafeNextPath(p: string | null | undefined): p is string {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//")) return false;
  if (p.includes("\\") || UNSAFE_CHARS.test(p) || SCHEME.test(p)) return false;
  return true;
}

/**
 * Where `GET /login` redirects (DESIGN §14): `next` when isSafeNextPath holds and resolving it against
 * `origin` keeps that origin with no user name or password, else `/`. Returns the resolved
 * path + query + fragment (dot segments removed), which must itself pass isSafeNextPath: removing dot
 * segments can turn `/..//evil.com` into the protocol-relative `//evil.com`.
 */
export function safeRedirectTarget(next: string | null | undefined, origin: string): string {
  if (!isSafeNextPath(next)) return "/";
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base.origin || url.username !== "" || url.password !== "") return "/";
  const out = `${url.pathname}${url.search}${url.hash}`;
  return isSafeNextPath(out) ? out : "/";
}

/** One-time login URL (DESIGN §14): `<origin>/login?code=<code>&next=<path>`. */
export function loginUrl(origin: string, code: string, next: string): string {
  return `${origin}${LOGIN_PATH}?code=${enc(code)}&next=${enc(next)}`;
}
