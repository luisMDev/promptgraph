/**
 * Session token. In production the server sets the pg_token cookie from `/?t=` and redirects, so the
 * token is not needed client-side. In dev (vite on another port) `?t=` is read here, kept in
 * sessionStorage and sent as Bearer header / `?t=` on the WS URL.
 */
export function getDevToken(): string | null {
  throw new Error("not implemented");
}
