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
import { revParse } from "../git/repo.js";
import { checkpointIfDirty } from "../runners/git/checkpoint.js";
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
  /** Merge stopped with conflicts; the lane worktree is mid-merge (MERGE_HEAD present). */
  | { status: "conflict"; files: string[] };

const DEFAULT_DIFF_MAX_BYTES = 1024 * 1024;

/**
 * Git worktree lanes (§9). Every git write on a lane goes through `withLaneLock` so there is at most
 * one git write per lane at a time (§8.4). Persists lanes in the store and emits `lane:update`.
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
   * checkpoint) for forks.
   */
  async createLane(run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    const { repo, paths, store } = this.deps;
    const baseRef = await revParse(repo.path, fromRef);
    const branch = this.branchName(run, planned.id);
    const dir = worktreePath(paths, repo.name, run.id, planned.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await gitOk(repo.path, ["worktree", "add", "-q", "-b", branch, dir, baseRef]);
    const lane = store.insertLane({ id: planned.id, runId: run.id, index: planned.index, branch, worktreePath: dir, baseRef });
    this.deps.bus.emit("lane:update", { lane });
    return lane;
  }

  /** §9.3: `git add -A && git commit -m "pg: checkpoint after <label>" --no-verify` if dirty. Returns new sha or null. */
  checkpoint(lane: Lane, afterLabel: string): Promise<string | null> {
    return this.withLaneLock(lane, () => checkpointIfDirty(lane.worktreePath, afterLabel));
  }

  headSha(lane: Lane): Promise<string> {
    return revParse(lane.worktreePath, "HEAD");
  }

  /** Lane diff vs merge-base with `baseBranch`, including uncommitted and untracked changes. */
  async diff(lane: Lane, baseBranch: string, maxBytes = DEFAULT_DIFF_MAX_BYTES): Promise<DiffResponse> {
    const cwd = lane.worktreePath;
    const head = await revParse(cwd, "HEAD");
    const mergeBase = await git(cwd, ["merge-base", baseBranch, "HEAD"]);
    const base = mergeBase.code === 0 ? mergeBase.stdout.trim() : lane.baseRef;
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
      const truncated = Buffer.byteLength(patch) > maxBytes;
      return {
        base,
        head,
        files: parseDiffFiles(numstat, nameStatus),
        patch: truncated ? Buffer.from(patch).subarray(0, maxBytes).toString("utf8") : patch,
        truncated,
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Merges `source` into `target` (§9.5, sequential pairwise, §18 Q4): checkpoints both first,
   * then `git merge --no-ff` (strategy "merge") or `git merge --squash` + commit (strategy "squash").
   * Marks `source` merged on success.
   */
  async merge(target: Lane, source: Lane, strategy: MergeConfig["strategy"], message: string): Promise<MergeAttempt> {
    await this.checkpoint(source, "merge");
    const attempt = await this.withLaneLock(target, async (): Promise<MergeAttempt> => {
      const cwd = target.worktreePath;
      await checkpointIfDirty(cwd, "merge");
      const args =
        strategy === "squash" ? ["merge", "--squash", source.branch] : ["merge", "--no-ff", "--no-verify", "-m", message, source.branch];
      const res = await git(cwd, args);
      if (res.code !== 0) {
        const files = await conflictedFiles(cwd);
        if (files.length > 0) return { status: "conflict", files };
        throw new Error(`git merge failed: ${(res.stderr || res.stdout).trim()}`);
      }
      if (strategy === "squash" && (await git(cwd, ["diff", "--cached", "--quiet"])).code !== 0) {
        await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", message]);
      }
      return { status: "merged", sha: await revParse(cwd, "HEAD") };
    });
    if (attempt.status === "merged") this.setStatus(source, "merged");
    return attempt;
  }

  /** After conflicts were resolved and staged: `git commit --no-edit`. Returns the merge sha. */
  concludeMerge(target: Lane): Promise<string> {
    return this.withLaneLock(target, async () => {
      await gitOk(target.worktreePath, ["commit", "-q", "--no-edit", "--no-verify"]);
      return revParse(target.worktreePath, "HEAD");
    });
  }

  /** `git merge --abort`. */
  async abortMerge(target: Lane): Promise<void> {
    await this.withLaneLock(target, () => gitOk(target.worktreePath, ["merge", "--abort"]));
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
      await this.withLaneLock(lane, async () => {
        if (fs.existsSync(lane.worktreePath)) {
          await gitOk(repo.path, ["worktree", "remove", "--force", lane.worktreePath]);
        }
        if (!lane.pushed && (lane.status === "merged" || !(await hasOwnCommits(repo.path, lane)))) {
          await git(repo.path, ["branch", "-D", lane.branch]);
        }
      });
      this.setStatus(lane, "removed");
    }
    await git(repo.path, ["worktree", "prune"]);
    fs.rmSync(path.join(paths.worktreesDir, repo.name, runId), { recursive: true, force: true });
    store.updateRun(runId, { cleanedUp: true });
  }

  /** `git worktree prune` (server start). */
  async prune(): Promise<void> {
    await gitOk(this.deps.repo.path, ["worktree", "prune"]);
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

async function conflictedFiles(cwd: string): Promise<string[]> {
  const res = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return res.stdout.split("\n").filter(Boolean);
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
