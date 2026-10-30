import fs from "node:fs";
import path from "node:path";
import { PromptNodeSchema, sumUsage, type GraphNodeOf, type Lane, type NodeRunOutput, type TokenUsage } from "@promptgraph/shared";
import { childEnv } from "../../config/child-env.js";
import { ptyLogPath, type PgPaths } from "../../config/paths.js";
import { git, gitOk } from "../../git/exec.js";
import { gitPath, hasMergeHead, hasPendingSquash, unmergedFiles } from "../../git/merge-state.js";
import { revParse } from "../../git/repo.js";
import type { PtyHandle, PtyManager } from "../../pty/pty-manager.js";
import type { LaneManager } from "../../workspace/lane-manager.js";
import { Interruption } from "../approval-runner.js";
import type { NodeControls, NodeExecution, Runner, RunnerContext, RunnerResult } from "../types.js";
import { squashMergeMessage } from "./checkpoint.js";

/** Prompt given to Claude on conflict (§9.5). */
export function conflictPrompt(files: string[]): string {
  return `Resolve the merge conflicts in: ${files.join(", ")}. Keep the intent of both branches. Run the tests if available. Then stage the files.`;
}

/** Commit message of a `--no-ff` merge or squash commit. */
export function mergeMessage(source: Lane, target: Lane): string {
  return `Merge branch '${source.branch}' into ${target.branch}`;
}

/** A line starting a conflict hunk (`<<<<<<< ours`) or ending one (`>>>>>>> theirs`). */
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;
const SHELL_KILL_WAIT_MS = 2000;

export interface MergeRunnerDeps {
  lanes: Pick<LaneManager, "merge" | "markMerged" | "withLaneLock">;
  ptys: PtyManager;
  /** Resolves conflicts with onConflict "claude" (the ClaudeRunner). */
  claude: Runner;
  paths: PgPaths;
  /** Base env for the conflict shell; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * merge nodes (§9.5, §18 Q4). The node runs in the lane of its first input; `ctx.mergeSources` (the
 * other input lanes, canvas order, checkpointed by the engine) are merged into it one at a time with
 * LaneManager.merge (`--no-ff`, or `--squash` + commit). On conflict:
 * - onConflict "claude": after `ctx.claudeSlot()` (maxParallelClaude), a Claude PTY (ClaudeRunner with a
 *   prompt node carrying conflictPrompt, context "clean", PTY id = nodeRun.id); Done/Fail/Hold/typing are
 *   forwarded to it;
 * - onConflict "pause": waiting_input {kind:"merge_conflict"} with an interactive shell (`shell-<nodeRunId>`)
 *   in the worktree until done(); a Done with conflicts left keeps waiting (message names the files).
 * Resolution is verified (no conflict markers in the conflicted files; they are staged; no unmerged paths
 * remain) and committed (`git commit --no-edit`, squash: the merge message + SQUASH_TRAILER); a merge that
 * was abandoned meanwhile (`git merge --abort`/`reset` in the shell or by Claude: the source is not an
 * ancestor of HEAD, or the squash is gone without a commit) fails the node. Then the source lane is
 * marked merged. Claude failing / unresolved conflicts / abandoned merge / fail() / cancel abort the merge
 * (hard reset to the pre-merge HEAD, so the lane is as before it, ready for a retry).
 * Output {sha, conflictedFiles, usage?}.
 */
export class MergeRunner implements Runner {
  constructor(private readonly deps: MergeRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const execution = new MergeExecution(this.deps, ctx);
    return { result: execution.result, controls: execution.controls };
  }
}

class MergeExecution {
  readonly result: Promise<RunnerResult>;
  readonly controls: NodeControls;
  private readonly stop: Interruption;
  private readonly conflicted = new Set<string>();
  private readonly usage: TokenUsage[] = [];
  /** Controls of the live Claude conflict resolver. */
  private claude: NodeControls | null = null;
  /** Pending Done of the pause mode. */
  private onDone: (() => void) | null = null;
  private hold: boolean;

  constructor(
    private readonly deps: MergeRunnerDeps,
    private readonly ctx: RunnerContext,
  ) {
    this.stop = new Interruption(ctx.signal);
    this.hold = ctx.nodeRun.hold;
    this.result = this.run().catch(
      (err: unknown): RunnerResult =>
        this.stop.outcome(this.output()) ?? { status: "failed", error: err instanceof Error ? err.message : String(err), output: this.output() },
    );
    this.controls = {
      done: () => (this.claude ? this.claude.done() : this.onDone?.()),
      fail: (reason) => {
        this.stop.fail(reason);
        this.claude?.fail(reason);
      },
      setHold: (hold) => {
        this.hold = hold;
        this.claude?.setHold(hold);
      },
      userInput: () => this.claude?.userInput?.(),
      cancel: async () => {
        this.stop.controller.abort();
        await this.result;
      },
    };
  }

  private async run(): Promise<RunnerResult> {
    const target = this.ctx.lane;
    for (const source of this.ctx.mergeSources) {
      this.throwIfStopped();
      const attempt = await this.deps.lanes.merge(target, source, this.config().strategy, mergeMessage(source, target));
      this.ctx.event("merge:attempt", { source: source.id, branch: source.branch, ...attempt });
      if (attempt.status === "conflict") {
        attempt.files.forEach((f) => this.conflicted.add(f));
        await this.resolveConflict(source, attempt.files, attempt.head);
      }
    }
    const sha = await gitOk(target.worktreePath, ["rev-parse", "HEAD"]);
    return { status: "succeeded", output: { ...this.output(), sha } };
  }

  private config(): GraphNodeOf<"merge">["config"] {
    return (this.ctx.node as GraphNodeOf<"merge">).config;
  }

  /** `head`: the target's HEAD before the merge, restored when the merge is aborted. */
  private async resolveConflict(source: Lane, files: string[], head: string): Promise<void> {
    try {
      if (this.config().onConflict === "claude") {
        await this.resolveWithClaude(files);
        const unresolved = await this.deps.lanes.withLaneLock(this.ctx.lane, () => this.conclude(source, files, head));
        if (unresolved.length > 0) throw new Error(`Unresolved merge conflicts remain in: ${unresolved.join(", ")}`);
      } else {
        await this.resolveManually(source, files, head);
      }
      this.deps.lanes.markMerged(source);
      this.ctx.event("merge:resolved", { source: source.id, files });
    } catch (err) {
      await this.abortMerge(head);
      throw err;
    }
  }

  private async resolveWithClaude(files: string[]): Promise<void> {
    const { node, nodeRun } = this.ctx;
    // fail() aborts only the merge's own signal, which claudeSlot() does not watch.
    const stopped = new Promise<never>((_, reject) =>
      this.stop.signal.addEventListener("abort", () => reject(new Error("Merge stopped")), { once: true }),
    );
    this.throwIfStopped();
    await Promise.race([this.ctx.claudeSlot(), stopped]);
    const prompt = PromptNodeSchema.parse({
      id: node.id,
      type: "prompt",
      label: node.label,
      position: node.position,
      config: { prompt: conflictPrompt(files), context: "clean" },
    });
    const execution = this.deps.claude.start({
      ...this.ctx,
      node: prompt,
      nodeRun: { ...nodeRun, hold: this.hold },
      predecessors: [],
      laneOutputs: [],
      previousAttempt: null,
      signal: this.stop.signal,
    });
    this.claude = execution.controls;
    const result = await execution.result.finally(() => (this.claude = null));
    if (result.status !== "cancelled" && result.output?.usage) this.usage.push(result.output.usage);
    this.throwIfStopped();
    if (result.status === "cancelled") throw new Error("Conflict resolution was cancelled");
    if (result.status === "failed") throw new Error(`Claude could not resolve the merge conflicts: ${result.error}`);
  }

  /** Shell in the worktree; each Done verifies and commits, or keeps waiting with the files left. */
  private async resolveManually(source: Lane, files: string[], head: string): Promise<void> {
    const shell = this.openShell();
    try {
      let message = `Resolve the merge conflicts in: ${files.join(", ")}. Stage the files, then click Done.`;
      for (;;) {
        this.ctx.update({ status: "waiting_input", ptyId: shell.id, waitingReason: { kind: "merge_conflict", message } });
        await this.waitForDone();
        const unresolved = await this.deps.lanes.withLaneLock(this.ctx.lane, () => this.conclude(source, files, head));
        if (unresolved.length === 0) break;
        message = `Unresolved merge conflicts remain in: ${unresolved.join(", ")}. Resolve and stage them, then click Done.`;
        this.ctx.event("merge:unresolved", { files: unresolved });
      }
      this.ctx.update({ status: "running" });
    } finally {
      await closeShell(shell);
    }
  }

  private openShell(): PtyHandle {
    const env = this.deps.env ?? process.env;
    const id = `shell-${this.ctx.nodeRun.id}`;
    return this.deps.ptys.spawn({
      id,
      file: env.SHELL || "/bin/sh",
      args: [],
      cwd: this.ctx.lane.worktreePath,
      env: childEnv({}, env),
      logPath: ptyLogPath(this.deps.paths, this.ctx.run.id, id),
    });
  }

  private waitForDone(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.onDone = null;
        reject(new Error("Merge stopped"));
      };
      if (this.stop.signal.aborted) return onAbort();
      this.stop.signal.addEventListener("abort", onAbort, { once: true });
      this.onDone = () => {
        this.onDone = null;
        this.stop.signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
  }

  /**
   * Under the lane lock: conflicted files still holding markers are unresolved; the others are staged
   * (`git add -A -- <files>`, deletions included). Then commits the merge — `--no-edit` while MERGE_HEAD
   * exists; squash: the merge message when changes are staged — and checks it really happened.
   * Returns the unresolved files (nothing is committed then). @throws when the merge was abandoned.
   */
  private async conclude(source: Lane, files: string[], head: string): Promise<string[]> {
    const cwd = this.ctx.lane.worktreePath;
    const withMarkers = files.filter((f) => hasConflictMarkers(path.join(cwd, f)));
    if (withMarkers.length > 0) return withMarkers;
    await gitOk(cwd, ["add", "-A", "--", ...files]);
    const unmerged = await unmergedFiles(cwd);
    if (unmerged.length > 0) return unmerged;
    const abandoned = new Error(`The merge of ${source.branch} was abandoned before it was committed (git merge --abort or reset?)`);
    if (this.config().strategy === "squash") {
      if ((await git(cwd, ["diff", "--cached", "--quiet"])).code !== 0) {
        const message = squashMergeMessage(mergeMessage(source, this.ctx.lane), await revParse(cwd, source.branch));
        await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", message]);
      } else if (await hasPendingSquash(cwd)) {
        // Resolved to no change at all: nothing to commit, but the squash must not stay pending.
        fs.rmSync(await gitPath(cwd, "SQUASH_MSG"), { force: true });
      } else if ((await revParse(cwd, "HEAD")) === head) {
        throw abandoned;
      }
      return [];
    }
    if (await hasMergeHead(cwd)) await gitOk(cwd, ["commit", "-q", "--no-edit", "--no-verify"]);
    if ((await git(cwd, ["merge-base", "--is-ancestor", source.branch, "HEAD"])).code !== 0) throw abandoned;
    return [];
  }

  /** Hard reset to the pre-merge HEAD: drops MERGE_HEAD/SQUASH_MSG and anything committed since. */
  private async abortMerge(head: string): Promise<void> {
    const cwd = this.ctx.lane.worktreePath;
    try {
      await this.deps.lanes.withLaneLock(this.ctx.lane, () => gitOk(cwd, ["reset", "-q", "--hard", head]));
    } catch (err) {
      this.ctx.event("merge:abort_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private throwIfStopped(): void {
    if (this.stop.signal.aborted) throw new Error("Merge stopped");
  }

  private output(): NodeRunOutput {
    return {
      conflictedFiles: [...this.conflicted],
      ...(this.usage.length > 0 ? { usage: sumUsage(this.usage) } : {}),
    };
  }
}

function hasConflictMarkers(file: string): boolean {
  try {
    return fs.statSync(file).isFile() && CONFLICT_MARKER.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** Interactive shells ignore SIGTERM: SIGHUP (terminal closed), then SIGKILL. */
async function closeShell(shell: PtyHandle): Promise<void> {
  if (!shell.isLive) return;
  shell.kill("SIGHUP");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), SHELL_KILL_WAIT_MS)));
  const exited = await Promise.race([shell.exited.then(() => true as const), timeout]);
  clearTimeout(timer);
  if (!exited) shell.kill("SIGKILL");
}
