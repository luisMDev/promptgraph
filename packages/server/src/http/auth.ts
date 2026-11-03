import { timingSafeEqual } from "node:crypto";
import { TOKEN_COOKIE, type ApiError } from "@promptgraph/shared";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hookToken, sessionCookieValue } from "../hooks/hook-token.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Paths that never get the `?t=` cookie flow (API clients send the Bearer header). */
const NON_PAGE_PREFIXES = ["/api/", "/hooks/", "/ws"];

function tokenMatches(token: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(header: string | null | undefined): string | null {
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return m?.[1] ?? null;
}

function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseHost(host: string): URL | null {
  try {
    return new URL(host.includes("://") ? host : `http://${host}`);
  } catch {
    return null;
  }
}

/** Loopback host on exactly `port` (0 = not listening yet: any port). */
function isOwnHost(host: string | null | undefined, port: number): boolean {
  const url = host ? parseHost(host) : null;
  if (!url || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  return port === 0 || Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port;
}

/**
 * §14 DNS-rebinding and cross-port check shared by HTTP and the WS upgrade: Host must be a loopback
 * name on the server's own port; Origin too, when present. Cookies are not port-scoped and
 * SameSite treats every localhost port as the same site, so another local web app (a dev server, a
 * docs server) must not be able to call the API or open the WebSocket with the user's cookie. The vite
 * dev proxy rewrites Origin to the server's own origin.
 */
export function isLocalRequest(host: string | null | undefined, origin: string | null | undefined, port = 0): boolean {
  return isOwnHost(host, port) && (origin === undefined || origin === null || isOwnHost(origin, port));
}

const deny = (error: string, code: string): ApiError => ({ error, code });

const HOOK_PATH = /^\/hooks\/([^/]+)\//;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Routes that need no credential: the daemon's identity check (DESIGN §4.1 item 3). */
const PUBLIC_ROUTES = new Set(["GET /api/daemon/hello", "HEAD /api/daemon/hello"]);

export interface TokenAuthOptions {
  /** The current token (read per request: `token rotate` swaps it in memory). */
  getToken: () => string;
  /** Per-start secret of the hook tokens (hookToken). */
  hookSecret: string;
}

/**
 * Requires `Authorization: Bearer <token>` or the `pg_token` cookie, except on PUBLIC_ROUTES. A request
 * to `/` (or any non-API page) with `?t=<token>` sets the cookie (HttpOnly, SameSite=Strict, Path=/) and
 * redirects to drop `t` (temporary page flow, replaced by one-time login codes, DESIGN §14).
 * The cookie holds sessionCookieValue(token), never the token: other local servers receive it too.
 * `/hooks/<nodeRunId>/*` accepts the Bearer token or that node run's hookToken(hookSecret, nodeRunId)
 * (the only credential Claude PTYs get; derived from the per-start hook secret, never from the token).
 * Cookie-authenticated API writes must be `application/json` so a cross-origin form/`text/plain` POST
 * cannot pass without a CORS preflight. 401/403 ApiError otherwise. Constant-time comparison.
 */
export function tokenAuth({ getToken, hookSecret }: TokenAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const token = getToken();
    const cookieSecret = sessionCookieValue(token);
    const url = new URL(c.req.url);
    if (PUBLIC_ROUTES.has(`${c.req.method} ${url.pathname}`)) return next();
    const hook = HOOK_PATH.exec(url.pathname);
    if (hook) {
      let nodeRunId: string;
      try {
        nodeRunId = decodeURIComponent(hook[1]!);
      } catch {
        nodeRunId = "";
      }
      const presented = bearer(c.req.header("authorization"));
      if (tokenMatches(token, presented) || (nodeRunId && tokenMatches(hookToken(hookSecret, nodeRunId), presented))) return next();
      return c.json(deny("Unauthorized: missing or invalid hook token", "unauthorized"), 401);
    }
    const t = url.searchParams.get("t");
    const isPage = c.req.method === "GET" && !NON_PAGE_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (isPage && t !== null && tokenMatches(token, t)) {
      setCookie(c, TOKEN_COOKIE, cookieSecret, { httpOnly: true, sameSite: "Strict", path: "/" });
      url.searchParams.delete("t");
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }
    if (tokenMatches(token, bearer(c.req.header("authorization")))) return next();
    if (tokenMatches(cookieSecret, getCookie(c, TOKEN_COOKIE))) {
      const contentType = c.req.header("content-type") ?? "";
      if (url.pathname.startsWith("/api/") && !SAFE_METHODS.has(c.req.method) && !/^application\/json\b/i.test(contentType)) {
        return c.json(deny("Forbidden: API writes must send Content-Type: application/json", "forbidden_content_type"), 403);
      }
      return next();
    }
    if (isPage) return c.text("promptgraph: unauthorized. Open the URL printed by the promptgraph command.", 401);
    return c.json(deny("Unauthorized: missing or invalid token", "unauthorized"), 401);
  };
}

/**
 * DNS-rebinding and cross-port protection (§14, isLocalRequest): Host and Origin (if present) must be
 * 127.0.0.1, localhost or [::1] on the server's port (`port()`; 0 before listening). 403 otherwise.
 */
export function localhostOnly(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (isLocalRequest(c.req.header("host"), c.req.header("origin"), port())) return next();
    return c.json(deny("Forbidden: requests must target localhost", "forbidden_host"), 403);
  };
}

/** Shared by the WS upgrade: validates the Bearer header, the cookie header or the `t` query param. */
export function isAuthorized(token: string, req: { headers: Record<string, string | string[] | undefined>; url?: string }): boolean {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (tokenMatches(token, bearer(header("authorization")))) return true;
  if (tokenMatches(sessionCookieValue(token), cookieValue(header("cookie"), TOKEN_COOKIE))) return true;
  const t = req.url ? new URL(req.url, "http://localhost").searchParams.get("t") : null;
  return tokenMatches(token, t);
}
