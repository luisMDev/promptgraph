import type { DiffResponse, KeepWorktrees, Lane, MergeConfig, PlannedLane, Run } from "@promptgraph/shared";
import type { EventBus } from "../events/bus.js";
import type { PgPaths } from "../config/paths.js";
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

/**
 * Git worktree lanes (§9). Every git write on a lane goes through `withLaneLock` so there is at most
 * one git write per lane at a time (§8.4). Persists lanes in the store and emits `lane:update`.
 */
export class LaneManager {
  constructor(private readonly deps: LaneManagerDeps) {}

  /** `<resolveBranchPrefix(graph)>/<run.shortId>/<laneId>` */
  branchName(run: Run, laneId: string): string {
    throw new Error("not implemented");
  }

  /**
   * `git worktree add -b <branch> <path> <fromRef>`; persists the lane (status active) with
   * baseRef = resolved sha of fromRef. fromRef: baseBranch for roots, parent lane head (after
   * checkpoint) for forks.
   */
  createLane(run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    throw new Error("not implemented");
  }

  /** §9.3: `git add -A && git commit -m "pg: checkpoint after <label>" --no-verify` if dirty. Returns new sha or null. */
  checkpoint(lane: Lane, afterLabel: string): Promise<string | null> {
    throw new Error("not implemented");
  }

  headSha(lane: Lane): Promise<string> {
    throw new Error("not implemented");
  }

  /** Lane diff vs merge-base with `baseBranch`, including uncommitted and untracked changes. */
  diff(lane: Lane, baseBranch: string, maxBytes?: number): Promise<DiffResponse> {
    throw new Error("not implemented");
  }

  /**
   * Merges `source` into `target` (§9.5, sequential pairwise, §18 Q4): checkpoints both first,
   * then `git merge --no-ff` (strategy "merge") or `git merge --squash` + commit (strategy "squash").
   * Marks `source` merged on success.
   */
  merge(target: Lane, source: Lane, strategy: MergeConfig["strategy"], message: string): Promise<MergeAttempt> {
    throw new Error("not implemented");
  }

  /** After conflicts were resolved and staged: `git commit --no-edit`. Returns the merge sha. */
  concludeMerge(target: Lane): Promise<string> {
    throw new Error("not implemented");
  }

  /** `git merge --abort`. */
  abortMerge(target: Lane): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * §9.6: per `keep` and whether the run failed, `git worktree remove --force` and delete local branches
   * that were not pushed. `force` ignores the policy (manual "Clean up"). Marks the run cleanedUp.
   */
  cleanup(runId: string, opts: { keep: KeepWorktrees; failed: boolean; force?: boolean }): Promise<void> {
    throw new Error("not implemented");
  }

  /** `git worktree prune` (server start). */
  prune(): Promise<void> {
    throw new Error("not implemented");
  }

  /** Serialises git writes per lane. */
  withLaneLock<T>(lane: Pick<Lane, "runId" | "id">, fn: () => Promise<T>): Promise<T> {
    throw new Error("not implemented");
  }
}
