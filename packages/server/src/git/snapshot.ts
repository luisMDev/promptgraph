import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, gitOk } from "./exec.js";

/**
 * Per-node worktree snapshots (§9.7). A snapshot is a commit of the worktree's whole state (HEAD plus
 * staged, unstaged and untracked changes; ignored files excluded) whose parent is HEAD. It is written
 * with a throwaway index and kept under a hidden ref, so HEAD, the lane's index and its branch never
 * change, and the lane's commits stay reachable after cleanup deletes the branch.
 */
export const SNAPSHOT_REF_PREFIX = "refs/promptgraph/";

export type SnapshotPoint = "start" | "end";

export function snapshotRef(runId: string, nodeRunId: string, point: SnapshotPoint): string {
  return `${SNAPSHOT_REF_PREFIX}${runId}/${nodeRunId}/${point}`;
}

/** Fixed identity: snapshots must not depend on (or fail without) the user's git config. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "promptgraph",
  GIT_AUTHOR_EMAIL: "promptgraph@localhost",
  GIT_COMMITTER_NAME: "promptgraph",
  GIT_COMMITTER_EMAIL: "promptgraph@localhost",
};

/** Snapshots the worktree at `cwd` into a commit, points `ref` at it, and returns its sha. */
export async function snapshotWorktree(cwd: string, ref: string, message: string): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-snap-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    // Starting from a copy of the real index keeps its stat cache: `add -A` then only hashes changed files.
    const realIndex = await gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, env.GIT_INDEX_FILE);
    else await gitOk(cwd, ["read-tree", "HEAD"], { env });
    await gitOk(cwd, ["add", "-A"], { env });
    const tree = await gitOk(cwd, ["write-tree"], { env });
    const sha = await gitOk(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", message], { env: SNAPSHOT_IDENTITY });
    await gitOk(cwd, ["update-ref", ref, sha]);
    return sha;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Run ids that have snapshot refs in the repository. */
export async function snapshotRunIds(repoPath: string): Promise<string[]> {
  const res = await git(repoPath, ["for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX], { readOnly: true });
  if (res.code !== 0) return [];
  const ids = new Set<string>();
  for (const ref of res.stdout.split("\n")) {
    const runId = ref.slice(SNAPSHOT_REF_PREFIX.length).split("/")[0];
    if (ref.startsWith(SNAPSHOT_REF_PREFIX) && runId) ids.add(runId);
  }
  return [...ids];
}

/** Deletes every snapshot ref of the given runs. */
export async function deleteSnapshotRefs(repoPath: string, runIds: readonly string[]): Promise<void> {
  if (runIds.length === 0) return;
  const refs = await gitOk(repoPath, ["for-each-ref", "--format=%(refname)", ...runIds.map((id) => `${SNAPSHOT_REF_PREFIX}${id}/`)]);
  const input = refs
    .split("\n")
    .filter(Boolean)
    .map((ref) => `delete ${ref}\n`)
    .join("");
  if (input) await gitOk(repoPath, ["update-ref", "--stdin"], { input });
}

/** Files changed and lines added/deleted between two commits (`git diff --shortstat`). */
export async function changeStats(cwd: string, from: string, to: string): Promise<{ files: number; additions: number; deletions: number }> {
  const out = await gitOk(cwd, ["diff", "--shortstat", "-M", "--no-ext-diff", from, to]);
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
  return { files: num(/(\d+) files? changed/), additions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) };
}
