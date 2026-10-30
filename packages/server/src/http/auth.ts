import { timingSafeEqual } from "node:crypto";
import { TOKEN_COOKIE, type ApiError } from "@promptgraph/shared";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

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

/** Host header (or Origin URL) whose hostname is a loopback name. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(host.includes("://") ? host : `http://${host}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(hostname);
}

/** §14 DNS-rebinding check shared by HTTP and the WS upgrade: Host must be loopback; Origin too, when present. */
export function isLocalRequest(host: string | null | undefined, origin: string | null | undefined): boolean {
  return isLoopbackHost(host) && (origin === undefined || origin === null || isLoopbackHost(origin));
}

const deny = (error: string, code: string): ApiError => ({ error, code });

/**
 * Requires `Authorization: Bearer <token>` or the `pg_token` cookie. A request to `/` (or any non-API
 * page) with `?t=<token>` sets the cookie (HttpOnly, SameSite=Strict, Path=/) and redirects to drop `t`.
 * 401 ApiError otherwise. Constant-time comparison.
 */
export function tokenAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const t = url.searchParams.get("t");
    const isPage = c.req.method === "GET" && !NON_PAGE_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (isPage && t !== null && tokenMatches(token, t)) {
      setCookie(c, TOKEN_COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/" });
      url.searchParams.delete("t");
      return c.redirect(`${url.pathname}${url.search}`, 302);
    }
    if (tokenMatches(token, bearer(c.req.header("authorization"))) || tokenMatches(token, getCookie(c, TOKEN_COOKIE))) {
      return next();
    }
    if (isPage) return c.text("promptgraph: unauthorized. Open the URL printed by the promptgraph command.", 401);
    return c.json(deny("Unauthorized: missing or invalid session token", "unauthorized"), 401);
  };
}

/**
 * DNS-rebinding protection (§14): the Host hostname must be 127.0.0.1, localhost or [::1]; Origin, if
 * present, too. The port is not checked so the vite dev proxy (which keeps its own Host) works. 403 otherwise.
 */
export function localhostOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (isLocalRequest(c.req.header("host"), c.req.header("origin"))) return next();
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
  if (tokenMatches(token, cookieValue(header("cookie"), TOKEN_COOKIE))) return true;
  const t = req.url ? new URL(req.url, "http://localhost").searchParams.get("t") : null;
  return tokenMatches(token, t);
}
