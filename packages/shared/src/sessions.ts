import { z } from "zod";

/** Browser/desktop session cookie (DESIGN §14): 32 random bytes; only its SHA-256 is stored. */
export const SESSION_COOKIE = "pg_session";
/** Sliding expiry: a session ends this long after its last use. */
export const SESSION_IDLE_MS = 30 * 24 * 3600_000;
/** One-time login codes are valid this long. */
export const LOGIN_CODE_TTL_MS = 30_000;

/** GET /api/daemon/sessions item (Bearer only). */
export const SessionSummarySchema = z.object({
  /** First 8 hex digits of the stored hash; what `promptgraph sessions revoke <id>` takes. */
  id: z.string().regex(/^[0-9a-f]{8}$/),
  /** Short user-agent summary ("Firefox", "promptgraph desktop"). */
  label: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  expiresAt: z.number(),
  /** The session of the request that listed them. */
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ListSessionsResponseSchema = z.object({ sessions: z.array(SessionSummarySchema) });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

/** DELETE /api/daemon/sessions/:id (an id prefix of at least 8 hex digits, or `all`; Bearer only). */
export const RevokeSessionsResponseSchema = z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() });
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponseSchema>;

/**
 * `:id` of DELETE /api/daemon/sessions/:id: `all` or an id prefix of 8–64 hex digits. Case-insensitive:
 * the input is lowercased before it is checked, so the output is always lowercase.
 */
export const SessionIdPrefixSchema = z
  .string()
  .transform((s) => s.toLowerCase())
  .pipe(z.union([z.literal("all"), z.string().regex(/^[0-9a-f]{8,64}$/)]));
