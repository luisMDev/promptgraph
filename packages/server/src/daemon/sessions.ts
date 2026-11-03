import { createHash, randomBytes } from "node:crypto";
import { SESSION_IDLE_MS, SessionIdPrefixSchema, type SessionSummary } from "@promptgraph/shared";
import type { EventBus } from "../events/bus.js";
import type { SessionRow, Store } from "../store/store.js";

const VALUE_BYTES = 32;
/** A 32-byte value in base64url is 43 characters; anything else is no session cookie. */
const VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** `last_seen_at` (and the sliding expiry) is written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = 3600_000;

/** A revocation target that is neither `all` nor an id prefix of 8+ hex digits. */
export class InvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`Invalid session id "${id}": give at least 8 hex digits of an id, or "all"`);
  }
}

/** SHA-256 hex of a cookie value: the only form a session is stored in (DESIGN §14). */
export function sessionHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Browser and desktop sessions (DESIGN §14) over the `sessions` table: the cookie value is 32 random
 * bytes and only its SHA-256 is stored. Expiry slides: SESSION_IDLE_MS after the last use, with
 * `last_seen_at` written at most once per SESSION_TOUCH_INTERVAL_MS. Revoking emits
 * `session:revoked {idHashes}` so the WebSocket hub closes those sessions' sockets with 4401.
 */
export class Sessions {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A new session; returns the cookie value (never stored). */
  create(label: string, now: number = this.now()): string {
    const value = randomBytes(VALUE_BYTES).toString("base64url");
    this.store.insertSession({ idHash: sessionHash(value), label, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_IDLE_MS });
    return value;
  }

  /**
   * The live session of a cookie value, or null. An expired session is deleted. A use more than
   * SESSION_TOUCH_INTERVAL_MS after the recorded one moves `last_seen_at` and the expiry.
   */
  verify(value: string | null | undefined, now: number = this.now()): SessionRow | null {
    if (typeof value !== "string" || !VALUE_PATTERN.test(value)) return null;
    const idHash = sessionHash(value);
    const row = this.store.getSession(idHash);
    if (!row) return null;
    if (row.expiresAt <= now) {
      this.drop(this.store.deleteSessions(idHash));
      return null;
    }
    if (now - row.lastSeenAt < SESSION_TOUCH_INTERVAL_MS) return row;
    const expiresAt = now + SESSION_IDLE_MS;
    this.store.touchSession(idHash, now, expiresAt);
    return { ...row, lastSeenAt: now, expiresAt };
  }

  /** Live sessions, newest first; `current` marks the one whose hash is `currentHash`. */
  list(currentHash?: string | null, now: number = this.now()): SessionSummary[] {
    this.deleteExpired(now);
    return this.store.listSessions().map((s) => ({
      id: s.idHash.slice(0, 8),
      label: s.label,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      current: s.idHash === currentHash,
    }));
  }

  /**
   * Deletes the sessions whose id starts with `id` (8+ hex digits; every match), or all of them with
   * "all". Returns how many were deleted. @throws InvalidSessionIdError
   */
  revoke(id: string): number {
    const target = SessionIdPrefixSchema.safeParse(id);
    if (!target.success) throw new InvalidSessionIdError(id);
    const deleted = this.store.deleteSessions(target.data);
    this.drop(deleted);
    return deleted.length;
  }

  revokeAll(): number {
    return this.revoke("all");
  }

  /**
   * Calls deleteExpired every `intervalMs` (unref'd, so it never keeps the process alive), so a socket
   * of a session that expires while connected is closed within one interval. Returns the stop function.
   */
  startSweep(intervalMs: number = SESSION_TOUCH_INTERVAL_MS): () => void {
    const timer = setInterval(() => this.deleteExpired(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Drops expired sessions (at daemon start, before listing and on every sweep) and emits `session:revoked` for them,
   * so a socket of a session that expired without a request since (the WebSocket never touches it) is
   * closed too. Returns how many were deleted.
   */
  deleteExpired(now: number = this.now()): number {
    const deleted = this.store.deleteExpiredSessions(now);
    this.drop(deleted);
    return deleted.length;
  }

  private drop(idHashes: string[]): void {
    if (idHashes.length > 0) this.bus.emit("session:revoked", { idHashes });
  }
}

/** Short label of a session from the user agent of the request that created it (DESIGN §14). */
export function sessionLabel(userAgent: string | null | undefined, desktop = false): string {
  const ua = userAgent ?? "";
  if (desktop || /\bTauri\b/i.test(ua)) return "promptgraph desktop";
  if (/\bFirefox\//.test(ua)) return "Firefox";
  if (/\b(Chrome|Chromium)\//.test(ua)) return "Chrome";
  return "Browser";
}
