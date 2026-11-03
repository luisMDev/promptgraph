import { SESSION_COOKIE, type ApiError } from "@promptgraph/shared";
import type { MiddlewareHandler } from "hono";
import { cookieValue } from "./credentials.js";

/** `Sec-Fetch-Site` values of a request a page of the daemon's own origin (or the user) made. */
const SAME_SITE_VALUES = new Set(["same-origin", "none"]);
/** `Sec-Fetch-Mode` values no API call of the UI uses: `<img>`/`<script>` loads and navigations. */
const FORBIDDEN_API_MODES = new Set(["no-cors", "navigate"]);

const isApi = (pathname: string) => pathname.startsWith("/api/");
const isWs = (pathname: string) => pathname === "/ws" || pathname.startsWith("/ws/");

/**
 * DESIGN §14 Fetch Metadata rule for a request that authenticates with the session cookie: to `/api/*`
 * or `/ws`, a present `Sec-Fetch-Site` other than `same-origin`/`none` is cross-site; to `/api/*`, a
 * `Sec-Fetch-Mode` of `no-cors` or `navigate` is too. Other localhost ports are the same site for
 * SameSite, so their `<img>`, `<script>` and navigations carry the cookie and no Origin; this refuses
 * them. Requests without Sec-Fetch-* headers (non-browser clients, old browsers) pass.
 */
export function isCrossSiteCookieRequest(pathname: string, header: (name: string) => string | null | undefined): boolean {
  if (!isApi(pathname) && !isWs(pathname)) return false;
  const site = header("sec-fetch-site");
  if (site && !SAME_SITE_VALUES.has(site.toLowerCase())) return true;
  const mode = header("sec-fetch-mode");
  return isApi(pathname) && !!mode && FORBIDDEN_API_MODES.has(mode.toLowerCase());
}

/**
 * Applies isCrossSiteCookieRequest to cookie-authenticated requests (a `pg_session` cookie and no
 * Authorization header): 403 `forbidden_cross_site`. Runs before tokenAuth. Bearer requests come from
 * local non-browser clients and are not subject to it.
 */
export function fetchMetadata(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header("authorization") || cookieValue(c.req.header("cookie"), SESSION_COOKIE) === null) return next();
    // c.req.path is the percent-decoded path the router matches: deciding on the raw pathname would let
    // `/ap%69/...` skip the rule and still reach the API routes.
    if (!isCrossSiteCookieRequest(c.req.path, (name) => c.req.header(name))) return next();
    const body: ApiError = { error: "Forbidden: cross-site request", code: "forbidden_cross_site" };
    return c.json(body, 403);
  };
}
