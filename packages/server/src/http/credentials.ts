import { timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE } from "@promptgraph/shared";
import type { Sessions } from "../daemon/sessions.js";
import type { SessionRow } from "../store/store.js";

/** Constant-time comparison of a presented credential with the expected one. */
export function tokenMatches(expected: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The credential of an `Authorization: Bearer <credential>` header. */
export function bearer(header: string | null | undefined): string | null {
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return m?.[1] ?? null;
}

/** Value of cookie `name` in a Cookie header (first occurrence), or null. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
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

/** How a request authenticated: the token (local clients) or a browser session (DESIGN §14). */
export type Credential = { kind: "bearer" } | { kind: "session"; session: SessionRow };

export interface CredentialSources {
  /** The current token (read per request: rotation swaps it in memory). */
  getToken: () => string;
  sessions: Sessions;
}

/**
 * The Bearer token, or else the `pg_session` cookie verified through `sessions` (sliding expiry). A
 * request that carries an Authorization header is judged by it alone: it never falls back to the
 * cookie, so the Fetch Metadata check (which skips requests with an Authorization header) cannot be
 * sidestepped. Null when neither is valid.
 */
export function authenticate(
  sources: CredentialSources,
  headers: { authorization?: string | null; cookie?: string | null },
): Credential | null {
  if (headers.authorization) return tokenMatches(sources.getToken(), bearer(headers.authorization)) ? { kind: "bearer" } : null;
  const session = sources.sessions.verify(cookieValue(headers.cookie, SESSION_COOKIE));
  return session ? { kind: "session", session } : null;
}
