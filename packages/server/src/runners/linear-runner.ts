import {
  DEFAULT_LINEAR_UPDATE_PROMPT,
  LINEAR_UPDATE_JSON_SCHEMA,
  LinearUpdateSuggestionSchema,
  type ApprovalRequest,
  type GraphNodeOf,
  type HeadlessResult,
  type LinearUpdateDecision,
  type LinearUpdateProposal,
  type LinearUpdateResult,
  type LinearUpdateSuggestion,
  type NodeRunOutput,
  type TokenUsage,
} from "@promptgraph/shared";
import { git } from "../git/exec.js";
import type { LinearIssueContext } from "../linear/client.js";
import { errorMessage, truncate } from "../util/text.js";
import { ApprovalGate, approvalOutput, rejectionError } from "./approval-runner.js";
import { describePredecessor } from "./claude/context.js";
import { runHeadless } from "./claude/headless.js";
import { headlessUsage } from "./git/messages.js";
import { isCheckpointMessage } from "./git/checkpoint.js";
import { Interruption } from "./interruption.js";
import type { NodeExecution, PredecessorOutput, Runner, RunnerContext, RunnerResult } from "./types.js";

/** What the runner needs from the daemon's Linear connection (LinearService); the key never reaches the runner. */
export interface LinearWriter {
  issueContext(ids: readonly string[]): Promise<LinearIssueContext[]>;
  comment(issueId: string, body: string): Promise<void>;
  setState(issueId: string, stateId: string): Promise<void>;
}

export interface ProposeInput {
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}

/** The headless call that proposes the updates; tests inject a fake. */
export type Propose = (input: ProposeInput) => Promise<{ suggestion: LinearUpdateSuggestion; usage: TokenUsage | null }>;

export interface LinearRunnerDeps {
  linear: LinearWriter;
  env?: NodeJS.ProcessEnv;
  propose?: Propose;
}

const DEFAULT_TIMEOUT_SEC = 300;
const OUTPUT_LIMIT = 3000;
const DIFF_LIMIT = 6000;
const DESCRIPTION_LIMIT = 2000;

/** Default Propose: `claude -p --json-schema LINEAR_UPDATE_JSON_SCHEMA` in the lane worktree. @throws on bad output */
export const proposeWithClaude: Propose = async (input) => {
  const result = await runHeadless({
    prompt: input.prompt,
    cwd: input.cwd,
    jsonSchema: LINEAR_UPDATE_JSON_SCHEMA,
    model: input.model,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    env: input.env,
  });
  return { suggestion: parseSuggestion(result), usage: headlessUsage(result, input.model) };
};

function parseSuggestion(result: HeadlessResult): LinearUpdateSuggestion {
  let value = result.structured_output;
  if (value === undefined && result.result) {
    try {
      value = JSON.parse(result.result);
    } catch {
      // Reported below.
    }
  }
  const parsed = LinearUpdateSuggestionSchema.safeParse(value);
  if (!parsed.success) throw new Error("Claude did not return the updates in the expected format");
  return parsed.data;
}

export interface LinearPromptInput {
  instructions: string;
  issues: LinearIssueContext[];
  allowComments: boolean;
  allowStateChanges: boolean;
  diffStat: string;
  commits: string[];
  outputs: PredecessorOutput[];
}

/** The headless prompt (§24.5): the node's instructions, the issues with their allowed states, then the run's work. */
export function buildLinearPrompt(input: LinearPromptInput): string {
  const rules = [
    "Answer with one entry per issue you update, using its identifier.",
    input.allowComments ? 'comment: a progress comment in Markdown for the team, or "" for none.' : 'comment: always "" (comments are disabled for this step).',
    input.allowStateChanges
      ? 'state: the exact name of one of the issue\'s allowed states to move it to, or "" to keep its state.'
      : 'state: always "" (state changes are disabled for this step).',
    "Do not invent work that the information below does not show.",
  ];
  const issues = input.issues
    .map((i) =>
      [
        `### ${i.identifier}: ${i.title}`,
        `Current state: ${i.currentState?.name ?? "unknown"}`,
        `Allowed states: ${i.states.map((s) => s.name).join(", ") || "(none)"}`,
        i.description.trim() ? `Description:\n${truncate(i.description.trim(), DESCRIPTION_LIMIT)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const outputs = input.outputs.map((p) => `### ${p.label || p.nodeId} (${p.type})\n${truncate(describePredecessor(p), OUTPUT_LIMIT)}`).join("\n\n");
  return [
    input.instructions.trim(),
    rules.join("\n"),
    `Linked Linear issues:\n\n${issues}`,
    `Changes in this run (diff stat):\n${truncate(input.diffStat.trim() || "(none)", DIFF_LIMIT)}`,
    input.commits.length ? `Commits:\n${input.commits.map((c) => `- ${c}`).join("\n")}` : "",
    outputs ? `Work done by the previous steps:\n\n${outputs}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One proposal per linked issue (in the graph's order), filled from Claude's suggestion: unknown identifiers are
 * ignored, a state is matched by name (case-insensitive) among the issue's team's states and dropped when unknown or
 * already current, and disabled kinds of update are dropped.
 */
export function buildProposals(
  issues: LinearIssueContext[],
  suggestion: LinearUpdateSuggestion,
  opts: { allowComments: boolean; allowStateChanges: boolean },
): LinearUpdateProposal[] {
  const byIdentifier = new Map(suggestion.updates.map((u) => [u.identifier.trim().toUpperCase(), u]));
  return issues.map((i) => {
    const u = byIdentifier.get(i.identifier.toUpperCase());
    const wanted = opts.allowStateChanges ? u?.state.trim().toLowerCase() : "";
    const state = wanted ? i.states.find((s) => s.name.toLowerCase() === wanted) : undefined;
    return {
      issueId: i.issueId,
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      currentState: i.currentState,
      states: i.states,
      comment: opts.allowComments ? (u?.comment.trim() ?? "") : "",
      stateId: state && state.id !== i.currentState?.id ? state.id : null,
    };
  });
}

/** Whether a proposal changes anything. */
export function hasChanges(p: Pick<LinearUpdateProposal, "comment" | "stateId">): boolean {
  return p.comment.trim() !== "" || p.stateId !== null;
}

/**
 * The updates to apply after approval: the dialog's edited decisions (proposals left out are skipped) or, without
 * them, the proposals as they are. A decision for an issue that was not proposed, a state outside the issue's
 * team's, and kinds of update the node disallows are dropped; so are decisions that change nothing.
 */
export function decisionsToApply(
  proposals: LinearUpdateProposal[],
  req: Pick<ApprovalRequest, "linearUpdates">,
  opts: { allowComments: boolean; allowStateChanges: boolean },
): Array<{ proposal: LinearUpdateProposal; comment: string; stateId: string | null }> {
  const decisions: LinearUpdateDecision[] = req.linearUpdates ?? proposals.map((p) => ({ issueId: p.issueId, comment: p.comment, stateId: p.stateId }));
  const byId = new Map(proposals.map((p) => [p.issueId, p]));
  const seen = new Set<string>();
  return decisions.flatMap((d) => {
    const proposal = byId.get(d.issueId);
    if (!proposal || seen.has(d.issueId)) return [];
    seen.add(d.issueId);
    const comment = opts.allowComments ? d.comment.trim() : "";
    const valid = d.stateId !== null && opts.allowStateChanges && proposal.states.some((s) => s.id === d.stateId) && d.stateId !== proposal.currentState?.id;
    const stateId = valid ? d.stateId : null;
    return hasChanges({ comment, stateId }) ? [{ proposal, comment, stateId }] : [];
  });
}

/** "ENG-1: commented, moved to In Review" lines. */
export function summarizeResults(results: LinearUpdateResult[]): string {
  if (results.length === 0) return "No Linear issue was updated.";
  return results
    .map((r) => {
      const done = [r.commented ? "commented" : "", r.movedTo ? `moved to ${r.movedTo}` : ""].filter(Boolean).join(", ");
      return `${r.identifier}: ${done || "not updated"}${r.error ? ` (error: ${r.error})` : ""}`;
    })
    .join("\n");
}

/**
 * linear nodes (DESIGN §24.5). The graph's linked issues are read from Linear (state, team states, description);
 * headless Claude proposes a comment and/or a new state per issue from the node's instructions (the default prompt
 * unless overridden), the run's diff stat and commits since the base, and the lane outputs + direct predecessors.
 * The proposal is the output (`linear.proposals`) and the node waits for approval, always: it writes outside the
 * machine. Approve (with the dialog's edits) → the daemon applies each update (comment, then state), continuing past
 * a failure; output `linear.results` and a summary in `text`; any failure fails the node. Reject → failed. No linked
 * issue, or nothing proposed → succeeded without asking.
 */
export class LinearUpdateRunner implements Runner {
  constructor(private readonly deps: LinearRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const stop = new Interruption(ctx.signal);
    const gate = new ApprovalGate(stop.signal);
    let output: NodeRunOutput = {};
    const record = (o: NodeRunOutput) => (output = { ...output, ...o });
    const result = this.run(ctx, stop, gate, record).catch(
      (err: unknown): RunnerResult => stop.outcome(output) ?? { status: "failed", error: errorMessage(err), output },
    );
    return {
      result,
      controls: {
        done: () => gate.approve({ approved: true }),
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

  private async run(ctx: RunnerContext, stop: Interruption, gate: ApprovalGate, record: (o: NodeRunOutput) => NodeRunOutput): Promise<RunnerResult> {
    const config = (ctx.node as GraphNodeOf<"linear">).config;
    const opts = { allowComments: config.allowComments, allowStateChanges: config.allowStateChanges };
    const linked = ctx.run.graphSnapshot.issues ?? [];
    if (linked.length === 0) return { status: "succeeded", output: record({ text: "No Linear issues are linked to this graph." }) };

    const issues = await this.deps.linear.issueContext(linked.map((i) => i.id));
    if (issues.length === 0) return { status: "failed", error: "Linear does not know any of the linked issues", output: record({}) };
    // Keep the graph's order.
    const ordered = linked.map((l) => issues.find((i) => i.issueId === l.id)).filter((i): i is LinearIssueContext => !!i);

    const cwd = ctx.lane.worktreePath;
    const base = (await git(cwd, ["rev-parse", "--verify", "-q", `${ctx.baseBranch}^{commit}`])).code === 0 ? ctx.baseBranch : ctx.lane.baseRef;
    const [stat, log] = await Promise.all([git(cwd, ["diff", "--stat", "--summary", base]), git(cwd, ["log", "--format=%s", `${base}..HEAD`])]);
    const prompt = buildLinearPrompt({
      instructions: config.prompt?.trim() || DEFAULT_LINEAR_UPDATE_PROMPT,
      issues: ordered,
      ...opts,
      diffStat: stat.stdout,
      commits: log.stdout.split("\n").filter((s) => s && !isCheckpointMessage(s)),
      outputs: messageInputs(ctx),
    });
    const { suggestion, usage } = await (this.deps.propose ?? proposeWithClaude)({
      prompt,
      cwd,
      model: config.model ?? ctx.run.graphSnapshot.settings.defaults.model,
      timeoutMs: (config.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
      signal: stop.signal,
      env: this.deps.env ?? process.env,
    });
    const proposals = buildProposals(ordered, suggestion, opts);
    ctx.update({ output: record({ linear: { proposals }, ...(usage ? { usage } : {}) }) });
    const aborted = stop.outcome(record({}));
    if (aborted) return aborted;
    if (!proposals.some(hasChanges)) return { status: "succeeded", output: record({ text: "Claude proposed no Linear updates." }) };

    ctx.update({ status: "waiting_approval" });
    const req = await gate.decision;
    if (!req) return stop.outcome(record({})) ?? { status: "cancelled" };
    if (!req.approved) return { status: "failed", error: rejectionError("Linear update", req), output: record(approvalOutput(req)) };
    ctx.update({ status: "running", output: record(approvalOutput(req)) });

    const results: LinearUpdateResult[] = [];
    for (const { proposal, comment, stateId } of decisionsToApply(proposals, req, opts)) {
      const r: LinearUpdateResult = { identifier: proposal.identifier, commented: false, movedTo: null, error: null };
      try {
        if (comment) {
          await this.deps.linear.comment(proposal.issueId, comment);
          r.commented = true;
        }
        if (stateId) {
          await this.deps.linear.setState(proposal.issueId, stateId);
          r.movedTo = proposal.states.find((s) => s.id === stateId)?.name ?? stateId;
        }
      } catch (err) {
        r.error = errorMessage(err);
      }
      results.push(r);
      ctx.event("linear:updated", r);
    }
    const out = record({ linear: { proposals, results }, text: summarizeResults(results) });
    const failed = results.filter((r) => r.error);
    if (failed.length) return { status: "failed", error: `Linear update failed for ${failed.map((r) => r.identifier).join(", ")}: ${failed[0]!.error}`, output: out };
    return { status: "succeeded", output: out };
  }
}

/** Lane outputs since the last commit plus the direct predecessors. */
function messageInputs(ctx: RunnerContext): PredecessorOutput[] {
  const seen = new Set(ctx.laneOutputs.map((p) => p.nodeId));
  return [...ctx.laneOutputs, ...ctx.predecessors.filter((p) => !seen.has(p.nodeId) && p.status === "succeeded")];
}
