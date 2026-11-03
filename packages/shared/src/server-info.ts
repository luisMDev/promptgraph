import { z } from "zod";

/**
 * Discovery record of a running promptgraph server (§19.1), written by the server once it listens to
 * `<PG_HOME>/servers/<repo-key>.json` (mode 0600, removed on shutdown) and read by local clients such
 * as `promptgraph mcp`. It holds the per-start token, so it lives next to the state DB, readable by
 * the user only. A record whose pid is no longer alive is stale.
 */
export const ServerInfoSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  /** Git top level the server manages (one server per repository). */
  repoPath: z.string(),
  port: z.number().int().positive(),
  /** Per-start session token (§14): `Authorization: Bearer <token>`. */
  token: z.string().min(1),
  /** promptgraph version of the server. */
  serverVersion: z.string(),
  startedAt: z.number(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
