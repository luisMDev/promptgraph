import type { MiddlewareHandler } from "hono";

/**
 * Requires `Authorization: Bearer <token>` or the `pg_token` cookie. A request to `/` (or any non-API
 * page) with `?t=<token>` sets the cookie (HttpOnly, SameSite=Strict, Path=/) and redirects to drop `t`.
 * 401 ApiError otherwise. Constant-time comparison.
 */
export function tokenAuth(token: string): MiddlewareHandler {
  throw new Error("not implemented");
}

/** DNS-rebinding protection (§14): Host must be 127.0.0.1:<port> or localhost:<port>; Origin, if present, too. 403 otherwise. */
export function localhostOnly(port: () => number): MiddlewareHandler {
  throw new Error("not implemented");
}

/** Shared by the WS upgrade: validates cookie header or `t` query param. */
export function isAuthorized(token: string, req: { headers: Record<string, string | string[] | undefined>; url?: string }): boolean {
  throw new Error("not implemented");
}
