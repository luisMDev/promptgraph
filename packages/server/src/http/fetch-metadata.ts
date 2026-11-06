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

const FRAME_ANCESTORS = "frame-ancestors 'none'";
/** `Sec-Fetch-Dest` values of a document loaded inside another page. */
const FRAME_DESTS = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/**
 * DESIGN §14 "never inside a frame": every response carries `X-Frame-Options: DENY` and
 * `Content-Security-Policy: frame-ancestors 'none'` (appended to a page's own policy), and a request whose `Sec-Fetch-Dest` says it loads
 * into a frame gets 403 `forbidden_frame`. Another localhost port is the same site, so its page could
 * otherwise frame the signed-in UI (whose own requests are same-origin) and click its buttons
 * (clickjacking an approval). Runs first, so even a refusal carries the headers.
 */
export function noFraming(): MiddlewareHandler {
  return async (c, next) => {
    const dest = c.req.header("sec-fetch-dest");
    if (dest && FRAME_DESTS.has(dest.toLowerCase())) {
      const body: ApiError = { error: "Forbidden: promptgraph pages cannot be framed", code: "forbidden_frame" };
      c.res = c.json(body, 403);
    } else {
      await next();
    }
    c.res.headers.set("x-frame-options", "DENY");
    const csp = c.res.headers.get("content-security-policy");
    if (!csp) c.res.headers.set("content-security-policy", FRAME_ANCESTORS);
    else if (!/(^|;)\s*frame-ancestors\b/i.test(csp)) c.res.headers.set("content-security-policy", `${csp}; ${FRAME_ANCESTORS}`);
  };
}
