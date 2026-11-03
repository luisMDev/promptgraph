import { z } from "zod";

/**
 * Discovery record of a pre-M7 per-repository server (`<PG_HOME>/servers/<repo-key>.json`). Nothing writes
 * it any more: the daemon only reads it to refuse starting while such a server runs and to delete stale
 * ones (DESIGN §4.4).
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
