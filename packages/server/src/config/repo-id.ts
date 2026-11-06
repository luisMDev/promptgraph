import { createHash } from "node:crypto";
import path from "node:path";

const SLUG_MAX = 24;

/**
 * Readable part of a repository id (DESIGN §4.2): the name lowercased, runs of characters outside
 * `[a-z0-9]` replaced by `-`, trimmed of `-`, at most 24 characters; `repo` when nothing is left.
 */
export function repoSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "repo";
}

/**
 * `<slug>-<hash8>` of a repository (DESIGN §4.2): stable across restarts and re-registration, distinct
 * for two checkouts with the same directory name. `realPath` must already be the realpath of the git
 * top level: two paths resolving to the same realpath are the same repository.
 */
export function repoIdFor(realPath: string): string {
  const hash = createHash("sha256").update(realPath).digest("hex").slice(0, 8);
  return `${repoSlug(path.basename(realPath))}-${hash}`;
}
