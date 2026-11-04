import { z } from "zod";

/**
 * GET /api/fs/dirs?path=&hidden=1 (DESIGN §12.1): the subdirectories of one directory, for the folder
 * picker of Home's "Add repository" (§13.3). `path` is absolute or `~`-prefixed; omitted, it is the
 * daemon user's home. Dot-directories are left out unless `hidden=1`. 422 path_not_absolute,
 * 404 not_a_directory, 403 permission_denied.
 */
export const ListDirsQuerySchema = z.object({
  path: z.string().optional(),
  hidden: z.enum(["0", "1"]).optional(),
});
export type ListDirsQuery = z.infer<typeof ListDirsQuerySchema>;

export const DirEntrySchema = z.object({
  name: z.string(),
  /** Absolute path of the entry (not resolved through symlinks). */
  path: z.string(),
  /** It holds a `.git` (directory or file): a repository top level or a linked worktree. */
  isGitRepo: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const ListDirsResponseSchema = z.object({
  /** The listed directory: absolute, `~` expanded, normalized. */
  path: z.string(),
  /** Its parent, or null at `/`. */
  parent: z.string().nullable(),
  /** The daemon user's home, for the picker's shortcut and to display `~`. */
  home: z.string(),
  /** The listed directory itself holds a `.git`. */
  isGitRepo: z.boolean(),
  /** Subdirectories (symlinks to directories included), sorted by name. */
  entries: z.array(DirEntrySchema),
});
export type ListDirsResponse = z.infer<typeof ListDirsResponseSchema>;
