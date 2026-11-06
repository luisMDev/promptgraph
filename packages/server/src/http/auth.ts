import { SESSION_COOKIE, SESSION_IDLE_MS, type ApiError } from "@promptgraph/shared";
import type { MiddlewareHandler } from "hono";
import type { Sessions } from "../daemon/sessions.js";
import { hookToken } from "../hooks/hook-token.js";
import { authenticate, bearer, cookieValue, tokenMatches } from "./credentials.js";
import type { AppEnv } from "./repo-scope.js";
import { signedOutPage } from "./signed-out-page.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Paths that are never pages: an unauthenticated request gets the JSON 401, not the signed-out page. */
const NON_PAGE_PREFIXES = ["/api/", "/hooks/"];

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

/** Routes that need no credential: the daemon's identity check (§4.1 item 3) and the sign-in page (§14). */
const PUBLIC_ROUTES = new Set(["GET /api/daemon/hello", "HEAD /api/daemon/hello", "GET /login"]);
/** Routes a session cookie must not reach (DESIGN §12.1 "Bearer only"): minting codes, rotation, sessions. */
const BEARER_ONLY = /^\/api\/daemon\/(login-codes|token\/rotate|sessions)(\/|$)/;

/** `Set-Cookie` value of a session (DESIGN §14); also renews it on page loads. */
export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_IDLE_MS / 1000}; Path=/; HttpOnly; SameSite=Strict`;
}

const isPagePath = (pathname: string) => pathname !== "/ws" && !pathname.startsWith("/ws/") && !NON_PAGE_PREFIXES.some((p) => pathname.startsWith(p));

export interface TokenAuthOptions {
  /** The current token (read per request: rotation swaps it in memory). */
  getToken: () => string;
  /** Per-start secret of the hook tokens (hookToken). */
  hookSecret: string;
  sessions: Sessions;
}

/**
 * Authentication of every HTTP request (DESIGN §14), after localhostOnly and fetchMetadata:
 * - PUBLIC_ROUTES (`GET /api/daemon/hello`, `GET /login`) need nothing.
 * - `/hooks/<nodeRunId>/*` accepts that node run's hookToken(hookSecret, nodeRunId) or the Bearer token
 *   (the hook token is the only credential Claude PTYs get, and it is refused everywhere else).
 * - Everything else needs `Authorization: Bearer <token>` (compared per request with getToken(), in
 *   constant time) or a live `pg_session` cookie (Sessions.verify, sliding expiry); a request with an
 *   Authorization header is judged by that header alone.
 * - Cookie requests: BEARER_ONLY routes → 403 `forbidden_cookie_auth`; API writes that are not
 *   `application/json` → 403 `forbidden_content_type` (a cross-origin form or `text/plain` POST cannot
 *   pass without a CORS preflight); HTML page responses renew the cookie (Max-Age reset).
 * - Unauthenticated: a page (GET/HEAD outside /api, /hooks and /ws) gets signedOutPage(), anything else
 *   the JSON 401 `unauthorized`. No URL query parameter is a credential (the token never travels in a URL).
 * The credential is stored in `c.var.credential`.
 */
export function tokenAuth({ getToken, hookSecret, sessions }: TokenAuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Every rule below decides on c.req.path, the percent-decoded path the router matches: on the raw
    // pathname, `/api/daemon/login%2Dcodes` or `/ap%69/...` would skip BEARER_ONLY or the content-type
    // rule and still reach those routes.
    const pathname = c.req.path;
    if (PUBLIC_ROUTES.has(`${c.req.method} ${pathname}`)) return next();
    const hook = HOOK_PATH.exec(pathname);
    if (hook) {
      let nodeRunId: string;
      try {
        nodeRunId = decodeURIComponent(hook[1]!);
      } catch {
        nodeRunId = "";
      }
      const presented = bearer(c.req.header("authorization"));
      if (tokenMatches(getToken(), presented) || (nodeRunId && tokenMatches(hookToken(hookSecret, nodeRunId), presented))) return next();
      return c.json(deny("Unauthorized: missing or invalid hook token", "unauthorized"), 401);
    }
    const isPage = (c.req.method === "GET" || c.req.method === "HEAD") && isPagePath(pathname);
    const credential = authenticate({ getToken, sessions }, { authorization: c.req.header("authorization"), cookie: c.req.header("cookie") });
    if (!credential) {
      if (isPage) return signedOutPage(c.req.method);
      return c.json(deny("Unauthorized: missing or invalid token", "unauthorized"), 401);
    }
    c.set("credential", credential);
    if (credential.kind === "bearer") return next();

    if (BEARER_ONLY.test(pathname)) {
      return c.json(deny("Forbidden: this route accepts the token only (run the promptgraph CLI)", "forbidden_cookie_auth"), 403);
    }
    const contentType = c.req.header("content-type") ?? "";
    if (pathname.startsWith("/api/") && !SAFE_METHODS.has(c.req.method) && !/^application\/json\b/i.test(contentType)) {
      return c.json(deny("Forbidden: API writes must send Content-Type: application/json", "forbidden_content_type"), 403);
    }
    await next();
    if (isPage && c.res.status === 200 && /^text\/html\b/i.test(c.res.headers.get("content-type") ?? "")) {
      const value = cookieValue(c.req.header("cookie"), SESSION_COOKIE);
      if (value) c.res.headers.append("set-cookie", sessionCookieHeader(value));
    }
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
