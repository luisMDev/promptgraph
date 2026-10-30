import type { GraphNodeOf, NodeRunOutput } from "@promptgraph/shared";
import { git, gitOk } from "../../git/exec.js";
import type { LaneManager } from "../../workspace/lane-manager.js";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "../types.js";
import { squashTarget } from "./checkpoint.js";
import { generateMessage } from "./messages.js";

export interface CommitRunnerDeps {
  lanes: Pick<LaneManager, "withLaneLock">;
  /** Base env for the headless message generator; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * commit nodes (§6.1, §9.3) under the lane lock: squashCheckpoints → `git reset --soft` to the last
 * non-checkpoint commit (messages starting "pg: checkpoint"); `git add -A`; nothing staged → succeeded
 * {noop:true}; message = config.message or generateMessage("commit"); `git commit -F -`.
 * Output {sha, message, usage?}.
 */
export class CommitRunner implements Runner {
  constructor(private readonly deps: CommitRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (ctx.signal.aborted) abort.abort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
    let failReason: string | null = null;

    const result = this.deps.lanes
      .withLaneLock(ctx.lane, () => this.commit(ctx, abort.signal))
      .then(
        (output): RunnerResult => (failReason ? { status: "failed", error: failReason, output } : { status: "succeeded", output }),
        (err: unknown): RunnerResult => {
          if (failReason) return { status: "failed", error: failReason };
          if (abort.signal.aborted) return { status: "cancelled" };
          return { status: "failed", error: err instanceof Error ? err.message : String(err) };
        },
      )
      .finally(() => ctx.signal.removeEventListener("abort", onAbort));

    return {
      result,
      controls: {
        done: () => undefined,
        setHold: () => undefined,
        fail: (reason) => {
          failReason ??= reason || "Marked as failed by the user";
          abort.abort();
        },
        cancel: async () => {
          abort.abort();
          await result;
        },
      },
    };
  }

  private async commit(ctx: RunnerContext, signal: AbortSignal): Promise<NodeRunOutput> {
    const node = ctx.node as GraphNodeOf<"commit">;
    const cwd = ctx.lane.worktreePath;
    const checkAborted = () => {
      if (signal.aborted) throw new Error("aborted");
    };

    if (node.config.squashCheckpoints) {
      const target = await squashTarget(cwd, ctx.lane.baseRef);
      if (target) {
        await gitOk(cwd, ["reset", "-q", "--soft", target]);
        ctx.event("commit:squashed_checkpoints", { target });
      }
    }
    await gitOk(cwd, ["add", "-A"]);
    const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return { noop: true };
    checkAborted();

    const fixed = node.config.message?.trim();
    let message: string;
    let usage: NodeRunOutput["usage"];
    if (!node.config.generateMessage && fixed) {
      message = fixed;
    } else {
      const generated = await generateMessage({
        cwd,
        kind: "commit",
        diffStat: await gitOk(cwd, ["diff", "--cached", "--stat"]),
        outputs: ctx.predecessors,
        model: ctx.run.graphSnapshot.settings.defaults.model,
        signal,
        env: this.deps.env,
      });
      message = generated.body ? `${generated.title}\n\n${generated.body}` : generated.title;
      usage = generated.usage ?? undefined;
    }
    checkAborted();

    await gitOk(cwd, ["commit", "-q", "-F", "-"], { input: `${message}\n` });
    const sha = await gitOk(cwd, ["rev-parse", "HEAD"]);
    return { sha, message, ...(usage ? { usage } : {}) };
  }
}
