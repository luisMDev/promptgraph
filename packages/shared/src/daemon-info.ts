import { z } from "zod";

/**
 * Discovery record of the running daemon (DESIGN §4.1, §11.3): `<PG_HOME>/daemon.json`, mode 0600,
 * written atomically once the daemon is ready and removed on stop. It holds no secret: clients read
 * `<PG_HOME>/token` separately and send it only after `GET /api/daemon/hello` proved the daemon knows it.
 * A record is stale when its pid is dead, when that pid's start time differs from `pidStart` (pid reuse),
 * or when the hello proof fails.
 */
export const DaemonInfoSchema = z.object({
  version: z.literal(2),
  pid: z.number().int().positive(),
  /** Start time of `pid`: `/proc/<pid>/stat` field 22 (clock ticks since boot). */
  pidStart: z.number().int().nonnegative(),
  port: z.number().int().positive(),
  /** promptgraph version of the daemon. */
  serverVersion: z.string(),
  startedAt: z.number(),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

/** GET /api/daemon/hello?nonce=<16 random bytes, base64url> — public, no credentials (DESIGN §4.1 item 3). */
export const DaemonHelloResponseSchema = z.object({
  pid: z.number().int().positive(),
  serverVersion: z.string(),
  /** base64url(HMAC-SHA256(token, HELLO_PROOF_PREFIX + nonce)). */
  proof: z.string(),
});
export type DaemonHelloResponse = z.infer<typeof DaemonHelloResponseSchema>;

/** Prefix of the HMAC input of the hello proof (domain separation from other uses of the token). */
export const HELLO_PROOF_PREFIX = "hello:";

/** Exit code of `promptgraph daemon` when another daemon holds the lock (DESIGN §4). */
export const EXIT_DAEMON_LOCKED = 3;
