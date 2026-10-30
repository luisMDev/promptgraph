import {
  JUDGE_JSON_SCHEMA,
  regexError,
  type ConditionEvaluator,
  type GraphNodeOf,
  type HeadlessResult,
  type JudgeVerdict,
  type NodeRunOutput,
} from "@promptgraph/shared";
import vm from "node:vm";
import { git } from "../git/exec.js";
import { truncate } from "../util/text.js";
import { Interruption } from "./approval-runner.js";
import { describePredecessor } from "./claude/context.js";
import { runHeadless } from "./claude/headless.js";
import { headlessUsage } from "./git/messages.js";
import type { NodeExecution, PredecessorOutput, Runner, RunnerContext, RunnerResult } from "./types.js";

export interface ConditionRunnerDeps {
  /** Base env for the headless judge; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Max characters of the evaluated output / diff stat in the judge prompt. */
const JUDGE_OUTPUT_LIMIT = 8000;
const JUDGE_DIFF_STAT_LIMIT = 4000;
const DEFAULT_JUDGE_TIMEOUT_SEC = 120;
/** Regex evaluation runs in a vm context with this timeout (catastrophic backtracking must not block the server). */
const REGEX_TIMEOUT_MS = 1000;
/** Max characters of the subject a regex is tested on (the end is kept). */
const REGEX_SUBJECT_LIMIT = 100_000;

/** What an evaluator decided. */
export interface Evaluation {
  result: boolean;
  reason: string;
}

/**
 * Phase 2 condition nodes (§15.2). Evaluates the predecessor that ran (the first direct predecessor in
 * canvas order whose current node run succeeded or failed; a condition normally has exactly one):
 * - exitCode: `output.exitCode === equals` (default 0). A predecessor without an exit code (not a shell;
 *   the validator rejects that) fails the node; null (timeout/signal) evaluates to false.
 * - regex: `new RegExp(pattern, flags)` tested on `output.text ?? output.stdoutTail ?? error ?? ""` (last
 *   100k characters), in a vm context with a 1 s timeout (a backtracking pattern fails the node instead
 *   of blocking the server). An invalid pattern (also rejected by the validator, shared `regexError`)
 *   fails the node.
 * - A predecessor skipped by the user (§8.3 "treat as success") evaluates to true for exitCode/regex.
 * - judge: headless `claude -p --json-schema JUDGE_JSON_SCHEMA` (model `evaluator.model ??
 *   settings.defaults.model`, timeout `evaluator.timeoutSec ?? 120`) with the question, the predecessor's
 *   output (describePredecessor) and the lane diff stat vs the merge-base with `ctx.baseBranch`
 *   (uncommitted and untracked files included). Verdict from `structured_output`, else the JSON in
 *   `result`; none → failed.
 * Result: succeeded with output `{result, port: "true"|"false", text: reason}` plus the evaluated
 * predecessor's `exitCode`/`timedOut`/`stdoutTail` when it has them (so a fix node behind the false
 * port sees the failing output in its context block), and judge `usage`. The engine routes on
 * `output.port`. Errors → failed; fail()/abort → failed/cancelled.
 */
export class ConditionRunner implements Runner {
  constructor(private readonly deps: ConditionRunnerDeps = {}) {}

  start(ctx: RunnerContext): NodeExecution {
    const stop = new Interruption(ctx.signal);
    const result = this.evaluate(ctx, stop.signal).then(
      (output): RunnerResult => stop.outcome(output) ?? { status: "succeeded", output },
      (err: unknown): RunnerResult => stop.outcome() ?? { status: "failed", error: err instanceof Error ? err.message : String(err) },
    );
    return {
      result,
      controls: {
        done: () => undefined,
        setHold: () => undefined,
        fail: (reason) => stop.fail(reason),
        cancel: async () => {
          stop.controller.abort();
          await result;
        },
      },
    };
  }

  private async evaluate(ctx: RunnerContext, signal: AbortSignal): Promise<NodeRunOutput> {
    const node = ctx.node as GraphNodeOf<"condition">;
    const ev = node.config.evaluator;
    const pred = evaluatedPredecessor(ctx.predecessors);
    let evaluation: Evaluation;
    let usage: NodeRunOutput["usage"];
    switch (ev.kind) {
      case "exitCode":
        evaluation = evaluateExitCode(ev, pred);
        break;
      case "regex":
        evaluation = evaluateRegex(ev, pred);
        break;
      case "judge": {
        const diffStat = await laneDiffStat(ctx.lane.worktreePath, ctx.baseBranch, ctx.lane.baseRef);
        if (signal.aborted) throw new Error("aborted");
        const envelope = await runHeadless({
          prompt: buildJudgePrompt(ev.question, pred, diffStat),
          cwd: ctx.lane.worktreePath,
          jsonSchema: JUDGE_JSON_SCHEMA,
          model: ev.model ?? ctx.run.graphSnapshot.settings.defaults.model,
          timeoutMs: (ev.timeoutSec ?? DEFAULT_JUDGE_TIMEOUT_SEC) * 1000,
          signal,
          env: this.deps.env,
        });
        usage = headlessUsage(envelope, ev.model ?? ctx.run.graphSnapshot.settings.defaults.model);
        const verdict = parseJudgeVerdict(envelope);
        if (!verdict) throw new Error(`Judge returned no verdict: ${truncate((envelope.result ?? "").trim() || "(empty)", 300)}`);
        evaluation = { result: verdict.pass, reason: verdict.reason.trim() || (verdict.pass ? "Judge: yes." : "Judge: no.") };
        break;
      }
    }
    ctx.event("condition:evaluated", { kind: ev.kind, result: evaluation.result, predecessor: pred.nodeId });
    return {
      ...evaluatedOutput(pred),
      result: evaluation.result,
      port: evaluation.result ? "true" : "false",
      text: evaluation.reason,
      ...(usage ? { usage } : {}),
    };
  }
}

/**
 * The predecessor whose output is evaluated: the first (canvas order) that ran, else the first one the user
 * skipped (§8.3 "treat as success": exitCode/regex evaluate it as true). @throws when none.
 */
export function evaluatedPredecessor(preds: readonly PredecessorOutput[]): PredecessorOutput {
  const ran = preds.find((p) => p.status === "succeeded" || p.status === "failed") ?? preds.find(skippedByUser);
  if (ran) return ran;
  if (preds.length === 0) throw new Error("Condition node has no predecessor to evaluate");
  throw new Error(`No predecessor output to evaluate (${preds.map((p) => `"${labelOf(p)}" is ${p.status}`).join(", ")})`);
}

function skippedByUser(p: PredecessorOutput): boolean {
  return p.status === "skipped" && p.output?.skippedByUser === true;
}

const skippedEvaluation = (pred: PredecessorOutput): Evaluation => ({
  result: true,
  reason: `"${labelOf(pred)}" was skipped by you; treated as success.`,
});

export function evaluateExitCode(ev: Extract<ConditionEvaluator, { kind: "exitCode" }>, pred: PredecessorOutput): Evaluation {
  if (skippedByUser(pred)) return skippedEvaluation(pred);
  const exitCode = pred.output?.exitCode;
  if (exitCode === undefined) {
    throw new Error(`Exit-code condition: predecessor "${labelOf(pred)}" (${pred.type}) has no exit code; connect a shell node`);
  }
  if (exitCode === null) {
    return { result: false, reason: `"${labelOf(pred)}" has no exit code${pred.output?.timedOut ? " (timed out)" : " (killed)"}; expected ${ev.equals}.` };
  }
  const result = exitCode === ev.equals;
  return { result, reason: `Exit code ${exitCode} ${result ? "equals" : "does not equal"} ${ev.equals}.` };
}

export function evaluateRegex(ev: Extract<ConditionEvaluator, { kind: "regex" }>, pred: PredecessorOutput): Evaluation {
  const invalid = regexError(ev.pattern, ev.flags);
  if (invalid) throw new Error(`Invalid regex: ${invalid}`);
  if (skippedByUser(pred)) return skippedEvaluation(pred);
  const subject = (pred.output?.text ?? pred.output?.stdoutTail ?? pred.error ?? "").slice(-REGEX_SUBJECT_LIMIT);
  const match = execRegex(ev.pattern, ev.flags, subject);
  const shown = `/${ev.pattern}/${ev.flags}`;
  if (match === null) return { result: false, reason: `No match for ${shown} in the output of "${labelOf(pred)}".` };
  return { result: true, reason: `${shown} matched ${JSON.stringify(truncate(match, 200))} in the output of "${labelOf(pred)}".` };
}

/**
 * The first match of `pattern` in `subject` (null when none), run in a vm context with a timeout so a
 * catastrophically backtracking pattern fails the node instead of blocking the server. A fresh RegExp per
 * evaluation (a global/sticky one keeps lastIndex between exec() calls).
 */
export function execRegex(pattern: string, flags: string, subject: string, timeoutMs = REGEX_TIMEOUT_MS): string | null {
  const context = vm.createContext({ pattern, flags, subject });
  try {
    return vm.runInContext("{ const m = new RegExp(pattern, flags).exec(subject); m === null ? null : String(m[0]); }", context, {
      timeout: timeoutMs,
    }) as string | null;
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error(`Regex evaluation timed out after ${timeoutMs} ms: simplify the pattern (nested quantifiers like (a+)+ backtrack)`);
    }
    throw err;
  }
}

export function buildJudgePrompt(question: string, pred: PredecessorOutput, diffStat: string): string {
  return [
    "You evaluate a yes/no condition in an automated coding workflow. Answer the question below using the output " +
      "of the previous step and the summary of the changes on the working branch. Set pass to true if the answer " +
      "is yes and false if it is no, and give a short reason (one or two sentences) that the next step can act on.",
    `Question: ${question.trim()}`,
    `Output of the previous step "${labelOf(pred)}" (${pred.type}, ${pred.status}):\n${truncate(describePredecessor(pred), JUDGE_OUTPUT_LIMIT)}`,
    `Changes on the working branch (diff stat):\n${truncate(diffStat.trim() || "(no changes)", JUDGE_DIFF_STAT_LIMIT)}`,
  ].join("\n\n");
}

/**
 * Verdict from the envelope: `structured_output`, else JSON in `result` (bare, fenced or embedded in
 * prose). `pass` may also be "true"/"false"/"yes"/"no"; a missing reason is "". Null when absent.
 */
export function parseJudgeVerdict(envelope: Pick<HeadlessResult, "structured_output" | "result">): JudgeVerdict | null {
  const fromValue = (value: unknown): JudgeVerdict | null => {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    const pass = toBoolean(v.pass);
    if (pass === null) return null;
    return { pass, reason: typeof v.reason === "string" ? v.reason : "" };
  };
  const structured = fromValue(envelope.structured_output);
  if (structured) return structured;
  const text = envelope.result?.trim();
  if (!text) return null;
  for (const candidate of [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const verdict = fromValue(JSON.parse(candidate));
      if (verdict) return verdict;
    } catch {
      // Not JSON.
    }
  }
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "yes") return true;
    if (s === "false" || s === "no") return false;
  }
  return null;
}

/**
 * `git diff --stat --summary` of the worktree (uncommitted changes included) against the merge-base with
 * `baseBranch` (fallback `baseRef`), plus untracked files. Errors yield "(diff unavailable: …)" — the
 * judge still runs.
 */
export async function laneDiffStat(cwd: string, baseBranch: string, baseRef: string): Promise<string> {
  try {
    const mergeBase = await git(cwd, ["merge-base", baseBranch, "HEAD"]);
    const base = mergeBase.code === 0 ? mergeBase.stdout.trim() : baseRef;
    const [stat, untracked] = await Promise.all([
      git(cwd, ["diff", "--stat", "--summary", "--no-color", base]),
      git(cwd, ["ls-files", "--others", "--exclude-standard"]),
    ]);
    if (stat.code !== 0) return `(diff unavailable: ${stat.stderr.trim()})`;
    const newFiles = untracked.code === 0 ? untracked.stdout.split("\n").filter(Boolean) : [];
    return [stat.stdout.trimEnd(), newFiles.length ? `Untracked files:\n${newFiles.map((f) => ` ${f}`).join("\n")}` : ""]
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    return `(diff unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Fields of the evaluated predecessor's output carried into the condition's output (context for successors). */
function evaluatedOutput(pred: PredecessorOutput): NodeRunOutput {
  const o = pred.output;
  return {
    ...(o?.exitCode !== undefined ? { exitCode: o.exitCode } : {}),
    ...(o?.timedOut !== undefined ? { timedOut: o.timedOut } : {}),
    ...(o?.stdoutTail !== undefined ? { stdoutTail: o.stdoutTail } : {}),
  };
}

function labelOf(p: PredecessorOutput): string {
  return p.label || p.nodeId;
}
