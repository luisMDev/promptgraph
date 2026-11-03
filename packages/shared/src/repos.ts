import { z } from "zod";

/**
 * Repository id (DESIGN §4.2): `<slug>-<hash8>`. `slug` is the directory name lowercased, runs of
 * characters outside `[a-z0-9]` replaced by `-`, trimmed, at most 24 characters (`repo` if empty);
 * `hash8` is the first 8 hex digits of the SHA-256 of the realpath. Only the daemon derives it.
 */
export const REPO_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?-[0-9a-f]{8}$/;
export const RepoIdSchema = z.string().regex(REPO_ID_PATTERN);
export type RepoId = z.infer<typeof RepoIdSchema>;

/**
 * A registered repository as listed on Home and by `promptgraph ls` (DESIGN §13.3). Counters come from
 * the DB (one grouped query), so inactive repositories have them too.
 */
export const RepoSummarySchema = z.object({
  id: RepoIdSchema,
  /** Realpath of the git top level (= runs.repo_path). */
  path: z.string(),
  name: z.string(),
  /** The directory still exists. */
  available: z.boolean(),
  /** Its context is activated (graph watcher running, §4.2). */
  active: z.boolean(),
  /** Last activation failure, or null. */
  error: z.string().nullable(),
  addedAt: z.number(),
  lastOpenedAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runs: z.object({ running: z.number().int(), paused: z.number().int() }),
  /** `input` counts `idle` node runs too. */
  waiting: z.object({ approval: z.number().int(), input: z.number().int() }),
});
export type RepoSummary = z.infer<typeof RepoSummarySchema>;

/** GET /api/repos */
export const ListReposResponseSchema = z.object({ repos: z.array(RepoSummarySchema) });
export type ListReposResponse = z.infer<typeof ListReposResponseSchema>;

/** POST /api/repos — absolute or `~`-prefixed path; anything else → 422 path_not_absolute. */
export const AddRepoRequestSchema = z.object({ path: z.string().min(1) });
export type AddRepoRequest = z.infer<typeof AddRepoRequestSchema>;

/** DELETE /api/repos/:repoId?force=1 */
export const RemoveRepoQuerySchema = z.object({ force: z.enum(["0", "1"]).optional() });
export type RemoveRepoQuery = z.infer<typeof RemoveRepoQuerySchema>;
