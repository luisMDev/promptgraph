import { spawn } from "node:child_process";
import path from "node:path";
import type { GraphNodeOf, NodeRunOutput } from "@promptgraph/shared";
import { childEnv, ghBin } from "../../config/child-env.js";
import { git } from "../../git/exec.js";
import type { LaneManager } from "../../workspace/lane-manager.js";
import { ApprovalGate, approvalOutput, Interruption, rejectionError } from "../approval-runner.js";
import type { NodeExecution, PredecessorOutput, Runner, RunnerContext, RunnerResult } from "../types.js";
import { isCheckpointMessage } from "./checkpoint.js";
import { generateMessage } from "./messages.js";

export interface PrRunnerDeps {
  lanes: Pick<LaneManager, "withLaneLock" | "markPushed">;
  /** Base env for gh and the headless message generator; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const GH_TIMEOUT_MS = 120_000;
const PR_URL = /https?:\/\/\S+/g;

/** The proposal shown in the approval dialog (output.title/body) and used for `gh pr create`. */
interface Proposal {
  title: string;
  body: string;
  usage?: NodeRunOutput["usage"];
}

/**
 * pr nodes (§6.1, §10). The engine checkpoints a dirty lane first (§18 Q1). Title/body = config, or
 * generateMessage("pr") from `git diff --stat <base>...HEAD`, the lane's commit subjects and the lane
 * outputs + direct predecessors; stored in output {title, body} (the approval dialog reads them).
 * requireApproval (forced unless settings.allowPrWithoutApproval) → waiting_approval until approve()
 * (edited title/body override; reject → failed). Then `git push -u origin <branch>` (lane marked pushed)
 * and `<PG_GH_BIN|gh> pr create --base <base> --head <branch> --title <t> --body-file - [--draft]`.
 * Output {prUrl, title, body, approved?, comment?, usage?}. Push/gh errors → failed with stderr.
 */
export class PrRunner implements Runner {
  constructor(private readonly deps: PrRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const stop = new Interruption(ctx.signal);
    const gate = new ApprovalGate(stop.signal);
    let output: NodeRunOutput = {};
    const result = this.run(ctx, stop, gate, (o) => (output = { ...output, ...o })).catch(
      (err: unknown): RunnerResult =>
        stop.outcome(output) ?? { status: "failed", error: err instanceof Error ? err.message : String(err), output },
    );
    return {
      result,
      controls: {
        done: () => undefined,
        fail: (reason) => stop.fail(reason),
        setHold: () => undefined,
        approve: (req) => gate.approve(req),
        cancel: async () => {
          stop.controller.abort();
          await result;
        },
      },
    };
  }

  private async run(
    ctx: RunnerContext,
    stop: Interruption,
    gate: ApprovalGate,
    record: (o: NodeRunOutput) => NodeRunOutput,
  ): Promise<RunnerResult> {
    const node = ctx.node as GraphNodeOf<"pr">;
    const settings = ctx.run.graphSnapshot.settings;
    const base = ctx.baseBranch;
    const env = this.deps.env ?? process.env;
    const checkStop = () => {
      const aborted = stop.outcome(record({}));
      if (aborted) throw new StopError(aborted);
    };

    try {
      const proposal = await this.proposal(ctx, base, stop.signal, env);
      let { title, body } = proposal;
      ctx.update({ output: record({ title, body, ...(proposal.usage ? { usage: proposal.usage } : {}) }) });
      checkStop();

      if (node.config.requireApproval || !settings.allowPrWithoutApproval) {
        ctx.update({ status: "waiting_approval" });
        const req = await gate.decision;
        checkStop();
        if (!req) return { status: "cancelled" };
        if (!req.approved) return { status: "failed", error: rejectionError("Pull request", req), output: record(approvalOutput(req)) };
        title = req.title?.trim() || title;
        body = req.body ?? body;
        ctx.update({ status: "running", output: record({ ...approvalOutput(req), title, body }) });
      }

      const branch = ctx.lane.branch;
      const pushArgs = [...(await relativeOriginOverride(ctx.lane.worktreePath, ctx.run.repoPath)), "push", "-u", "origin", branch];
      const push = await this.deps.lanes.withLaneLock(ctx.lane, () => git(ctx.lane.worktreePath, pushArgs));
      if (push.code !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim()}`);
      this.deps.lanes.markPushed(ctx.lane);
      ctx.event("pr:pushed", { branch });
      checkStop();

      const args = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", "-"];
      if (node.config.draft) args.push("--draft");
      const prUrl = await createPr(args, { cwd: ctx.lane.worktreePath, input: body, env, signal: stop.signal });
      ctx.event("pr:created", { prUrl });
      return { status: "succeeded", output: record({ prUrl }) };
    } catch (err) {
      if (err instanceof StopError) return err.result;
      throw err;
    }
  }

  private async proposal(ctx: RunnerContext, base: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<Proposal> {
    const config = (ctx.node as GraphNodeOf<"pr">).config;
    const fixedTitle = config.title?.trim();
    if (fixedTitle && config.body !== undefined) return { title: fixedTitle, body: config.body };

    const cwd = ctx.lane.worktreePath;
    const range = (await git(cwd, ["rev-parse", "--verify", "-q", `${base}^{commit}`])).code === 0 ? base : ctx.lane.baseRef;
    const [stat, log] = await Promise.all([
      git(cwd, ["diff", "--stat", "--summary", `${range}...HEAD`]),
      git(cwd, ["log", "--format=%s", `${range}..HEAD`]),
    ]);
    const generated = await generateMessage({
      cwd,
      kind: "pr",
      diffStat: stat.stdout,
      commits: log.stdout.split("\n").filter((s) => s && !isCheckpointMessage(s)),
      outputs: messageInputs(ctx),
      model: ctx.run.graphSnapshot.settings.defaults.model,
      signal,
      env,
    });
    return {
      title: fixedTitle || generated.title,
      body: config.body ?? generated.body,
      ...(generated.usage ? { usage: generated.usage } : {}),
    };
  }
}

/** Carries an abort (fail/cancel) out of the run as its final result. */
class StopError extends Error {
  constructor(readonly result: RunnerResult) {
    super("stopped");
  }
}

/** Lane outputs since the last commit plus the direct predecessors (e.g. the commit node's message). */
function messageInputs(ctx: RunnerContext): PredecessorOutput[] {
  const seen = new Set(ctx.laneOutputs.map((p) => p.nodeId));
  return [...ctx.laneOutputs, ...ctx.predecessors.filter((p) => !seen.has(p.nodeId) && p.status === "succeeded")];
}

/**
 * Runs `gh` (never through a shell) and returns the PR URL it prints. A PR that already exists for the
 * branch (e.g. retry after a failure past `gh`) counts as created. @throws with gh's stderr.
 */
function createPr(
  args: string[],
  opts: { cwd: string; input: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin(opts.env), args, {
      cwd: opts.cwd,
      env: childEnv({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, GH_TIMEOUT_MS);
    opts.signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${ghBin(opts.env)}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", kill);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      const url = code === 0 ? lastUrl(stdout) : /already exists/i.test(stderr) ? lastUrl(stderr) : null;
      if (url) return resolve(url);
      if (code === 0) return reject(new Error(`gh pr create printed no PR URL: ${stdout.trim()}`));
      reject(new Error(`gh pr create failed (${code ?? "killed"}): ${stderr || stdout.trim()}`));
    });
  });
}

function lastUrl(text: string): string | null {
  return text.match(PR_URL)?.at(-1) ?? null;
}

/**
 * A relative local `origin` URL (e.g. "../origin.git") is relative to the main checkout, but the push runs
 * in the lane worktree elsewhere: pass the absolute path as a one-off pushurl. Empty when not needed.
 */
async function relativeOriginOverride(cwd: string, repoPath: string): Promise<string[]> {
  const url = (await git(cwd, ["config", "--get", "remote.origin.url"])).stdout.trim();
  const pushUrl = (await git(cwd, ["config", "--get", "remote.origin.pushurl"])).stdout.trim();
  if (pushUrl || !/^\.\.?\//.test(url)) return [];
  return ["-c", `remote.origin.pushurl=${path.resolve(repoPath, url)}`];
}
