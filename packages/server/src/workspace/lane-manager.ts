import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveBranchPrefix,
  type DiffFile,
  type DiffResponse,
  type KeepWorktrees,
  type Lane,
  type MergeConfig,
  type PlannedLane,
  type Run,
} from "@promptgraph/shared";
import type { EventBus } from "../events/bus.js";
import { worktreePath, type PgPaths } from "../config/paths.js";
import { git, gitOk } from "../git/exec.js";
import { gitPath, mergeInProgress, unmergedFiles } from "../git/merge-state.js";
import { revParse } from "../git/repo.js";
import { checkpointIfDirty, squashMergeMessage } from "../runners/git/checkpoint.js";
import type { Store } from "../store/store.js";

export interface RepoRef {
  /** Absolute path of the main checkout (git top-level). */
  path: string;
  /** basename(path); used in worktree paths. */
  name: string;
}

export interface LaneManagerDeps {
  store: Store;
  bus: EventBus;
  paths: PgPaths;
  repo: RepoRef;
}

export type MergeAttempt =
  | { status: "merged"; sha: string }
  /**
   * Merge stopped with conflicts; the lane worktree is mid-merge (MERGE_HEAD, or SQUASH_MSG for a squash).
   * `head`: the target's HEAD before the merge (after its checkpoint), to reset to on abort.
   */
  | { status: "conflict"; files: string[]; head: string };

const DEFAULT_DIFF_MAX_BYTES = 1024 * 1024;

/** Lock key of repo-level git writes (worktree add/remove/prune, branch -D). */
const REPO_LOCK = { runId: "", id: "repo" };

/**
 * Git worktree lanes (§9). Every git write on a lane goes through `withLaneLock` so there is at most
 * one git write per lane at a time (§8.4); repo-level writes (worktrees, branch deletion) are serialised
 * too, since concurrent `git worktree add` in one repo can fail. Persists lanes in the store and emits
 * `lane:update`.
 */
export class LaneManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: LaneManagerDeps) {}

  /** `<resolveBranchPrefix(graph)>/<run.shortId>/<laneId>` */
  branchName(run: Run, laneId: string): string {
    return `${resolveBranchPrefix(run.graphSnapshot)}/${run.shortId}/${laneId}`;
  }

  /**
   * `git worktree add -b <branch> <path> <fromRef>`; persists the lane (status active) with
   * baseRef = resolved sha of fromRef. fromRef: baseBranch for roots, parent lane head (after
   * checkpoint) for forks. Idempotent: a branch/worktree left by an earlier attempt that never got its
   * lane row (failed `worktree add`, crash before the insert) is removed first.
   */
  async createLane(run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    const { repo, paths, store } = this.deps;
    const baseRef = await revParse(repo.path, fromRef);
    const branch = this.branchName(run, planned.id);
    const dir = worktreePath(paths, repo.name, run.id, planned.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await this.withLaneLock(REPO_LOCK, async () => {
      await removeLeftovers(repo.path, branch, dir);
      await gitOk(repo.path, ["worktree", "add", "-q", "-b", branch, dir, baseRef]);
    });
    const lane = store.insertLane({ id: planned.id, runId: run.id, index: planned.index, branch, worktreePath: dir, baseRef });
    this.deps.bus.emit("lane:update", { lane });
    return lane;
  }

  /** §9.3: `git add -A && git commit -m "pg: checkpoint after <label>" --no-verify` if dirty. Returns new sha or null. */
  checkpoint(lane: Lane, afterLabel: string): Promise<string | null> {
    return this.withLaneLock(lane, () => checkpointIfDirty(lane.worktreePath, afterLabel));
  }

  /**
   * A lane left mid-merge (crash or failed abort while a merge node resolved conflicts) is reset to its
   * HEAD, which drops the half-done merge. Returns whether it was. Run before a merge node (re)starts.
   */
  resetInterruptedMerge(lane: Lane): Promise<boolean> {
    return this.withLaneLock(lane, async () => {
      if (!(await mergeInProgress(lane.worktreePath))) return false;
      await gitOk(lane.worktreePath, ["reset", "-q", "--hard", "HEAD"]);
      return true;
    });
  }

  headSha(lane: Lane): Promise<string> {
    return revParse(lane.worktreePath, "HEAD");
  }

  /**
   * Lane diff vs merge-base with `baseBranch`, including uncommitted and untracked changes; with
   * `committedOnly`, only up to `head` (what a push of `head` publishes).
   */
  async diff(lane: Lane, baseBranch: string, opts: { committedOnly?: boolean; maxBytes?: number } = {}): Promise<DiffResponse> {
    const cwd = lane.worktreePath;
    const maxBytes = opts.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
    const head = await revParse(cwd, "HEAD");
    const mergeBase = await git(cwd, ["merge-base", baseBranch, "HEAD"]);
    const base = mergeBase.code === 0 ? mergeBase.stdout.trim() : lane.baseRef;
    if (opts.committedOnly) {
      const common = ["diff", "-M", "--no-color", "--no-ext-diff", base, head];
      const [patch, numstat, nameStatus] = await Promise.all([
        gitOk(cwd, common),
        gitOk(cwd, [...common, "--numstat", "-z"]),
        gitOk(cwd, [...common, "--name-status", "-z"]),
      ]);
      return diffResponse(base, head, numstat, nameStatus, patch, maxBytes);
    }
    // A throwaway index (HEAD + every worktree change) lets `diff --cached` show untracked files
    // without touching the lane's real index.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-diff-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      await gitOk(cwd, ["read-tree", "HEAD"], { env });
      await gitOk(cwd, ["add", "-A"], { env });
      const common = ["diff", "--cached", "-M", "--no-color", "--no-ext-diff", base];
      const [patch, numstat, nameStatus] = await Promise.all([
        gitOk(cwd, common, { env }),
        gitOk(cwd, [...common, "--numstat", "-z"], { env }),
        gitOk(cwd, [...common, "--name-status", "-z"], { env }),
      ]);
      return diffResponse(base, head, numstat, nameStatus, patch, maxBytes);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Merges `source` into `target` (§9.5, sequential pairwise, §18 Q4): checkpoints both first,
   * then `git merge --no-ff` (strategy "merge") or `git merge --squash` + commit (strategy "squash").
   * Squash commits carry SQUASH_TRAILER (squashCheckpoints treats them like merges). Marks `source`
   * merged on success.
   */
  async merge(target: Lane, source: Lane, strategy: MergeConfig["strategy"], message: string): Promise<MergeAttempt> {
    await this.checkpoint(source, "merge");
    const attempt = await this.withLaneLock(target, async (): Promise<MergeAttempt> => {
      const cwd = target.worktreePath;
      await checkpointIfDirty(cwd, "merge");
      const head = await revParse(cwd, "HEAD");
      const args =
        strategy === "squash" ? ["merge", "--squash", source.branch] : ["merge", "--no-ff", "--no-verify", "-m", message, source.branch];
      const res = await git(cwd, args);
      if (res.code !== 0) {
        const files = await unmergedFiles(cwd);
        if (files.length > 0) return { status: "conflict", files, head };
        throw new Error(`git merge failed: ${(res.stderr || res.stdout).trim()}`);
      }
      if (strategy === "squash") {
        if ((await git(cwd, ["diff", "--cached", "--quiet"])).code !== 0) {
          await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", squashMergeMessage(message, await revParse(cwd, source.branch))]);
        } else {
          // Nothing to squash (the changes are already here): no pending squash may stay behind.
          fs.rmSync(await gitPath(cwd, "SQUASH_MSG"), { force: true });
        }
      }
      return { status: "merged", sha: await revParse(cwd, "HEAD") };
    });
    if (attempt.status === "merged") this.setStatus(source, "merged");
    return attempt;
  }

  /**
   * §9.6: per `keep` and whether the run failed, `git worktree remove --force` and delete local branches
   * that were not pushed. `force` ignores the policy (manual "Clean up"). Marks the run cleanedUp.
   * A branch that carries commits of its own (not merged into another lane) is kept, so the work of a
   * run without a `pr` node is never lost.
   */
  async cleanup(runId: string, opts: { keep: KeepWorktrees; failed: boolean; force?: boolean }): Promise<void> {
    const keep = opts.keep === "always" || (opts.keep === "on-failure" && opts.failed);
    if (keep && !opts.force) return;
    const { repo, store, paths } = this.deps;
    for (const lane of store.listLanes(runId)) {
      if (lane.status === "removed") continue;
      await this.withLaneLock(lane, () =>
        this.withLaneLock(REPO_LOCK, async () => {
          if (fs.existsSync(lane.worktreePath)) {
            await gitOk(repo.path, ["worktree", "remove", "--force", lane.worktreePath]);
          }
          if (!lane.pushed && (lane.status === "merged" || !(await hasOwnCommits(repo.path, lane)))) {
            await git(repo.path, ["branch", "-D", lane.branch]);
          }
        }),
      );
      this.setStatus(lane, "removed");
    }
    await this.withLaneLock(REPO_LOCK, () => git(repo.path, ["worktree", "prune"]));
    fs.rmSync(path.join(paths.worktreesDir, repo.name, runId), { recursive: true, force: true });
    store.updateRun(runId, { cleanedUp: true });
  }

  /** A source lane whose conflicted merge was concluded (clean merges are marked by `merge`). */
  markMerged(lane: Lane): void {
    this.setStatus(lane, "merged");
  }

  /** The lane's branch was pushed (pr node): cleanup keeps it (§9.6). */
  markPushed(lane: Lane): void {
    const updated = this.deps.store.updateLane(lane.runId, lane.id, { pushed: true });
    this.deps.bus.emit("lane:update", { lane: updated });
  }

  /** `git worktree prune` (server start). */
  async prune(): Promise<void> {
    await this.withLaneLock(REPO_LOCK, () => gitOk(this.deps.repo.path, ["worktree", "prune"]));
  }

  /** Serialises git writes per lane. */
  withLaneLock<T>(lane: Pick<Lane, "runId" | "id">, fn: () => Promise<T>): Promise<T> {
    const key = `${lane.runId}/${lane.id}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  private setStatus(lane: Lane, status: Lane["status"]): void {
    const updated = this.deps.store.updateLane(lane.runId, lane.id, { status });
    this.deps.bus.emit("lane:update", { lane: updated });
  }
}

/** Removes the worktree `dir` and `branch` of a lane that was never persisted (see createLane). */
async function removeLeftovers(repoPath: string, branch: string, dir: string): Promise<void> {
  if (fs.existsSync(dir)) {
    await git(repoPath, ["worktree", "remove", "--force", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await gitOk(repoPath, ["worktree", "prune"]);
  if ((await git(repoPath, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code === 0) {
    await gitOk(repoPath, ["branch", "-D", branch]);
  }
}

async function hasOwnCommits(repoPath: string, lane: Lane): Promise<boolean> {
  const res = await git(repoPath, ["rev-list", "--count", `${lane.baseRef}..refs/heads/${lane.branch}`]);
  return res.code === 0 && Number(res.stdout.trim()) > 0;
}

const STATUS_BY_LETTER: Record<string, DiffFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

function diffResponse(base: string, head: string, numstat: string, nameStatus: string, patch: string, maxBytes: number): DiffResponse {
  const truncated = Buffer.byteLength(patch) > maxBytes;
  return {
    base,
    head,
    files: parseDiffFiles(numstat, nameStatus),
    patch: truncated ? Buffer.from(patch).subarray(0, maxBytes).toString("utf8") : patch,
    truncated,
  };
}

/** Joins `--numstat -z` and `--name-status -z` output (same file order). */
function parseDiffFiles(numstat: string, nameStatus: string): DiffFile[] {
  const statuses: { status: DiffFile["status"]; path: string; oldPath?: string }[] = [];
  const ns = nameStatus.split("\0");
  for (let i = 0; i < ns.length && ns[i]; ) {
    const code = ns[i++]!;
    const status = STATUS_BY_LETTER[code[0]!] ?? "other";
    if (status === "renamed" || status === "copied") {
      const oldPath = ns[i++]!;
      statuses.push({ status, oldPath, path: ns[i++]! });
    } else {
      statuses.push({ status, path: ns[i++]! });
    }
  }
  const counts: { additions: number; deletions: number; binary: boolean }[] = [];
  const nm = numstat.split("\0");
  for (let i = 0; i < nm.length && nm[i]; ) {
    const [add = "-", del = "-", file = ""] = nm[i++]!.split("\t");
    if (file === "") i += 2; // rename/copy: the two paths follow as separate fields
    const binary = add === "-";
    counts.push({ additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary });
  }
  return statuses.map((s, i) => ({ ...s, ...(counts[i] ?? { additions: 0, deletions: 0, binary: false }) }));
}
