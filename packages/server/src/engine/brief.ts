import {
  BRIEF_JSON_SCHEMA,
  BriefSummarySchema,
  DEFAULT_BRIEF_MODEL,
  nodeDisplayLabel,
  type BriefSummary,
  type GraphNode,
  type HeadlessResult,
  type NodeRun,
  type Run,
  type RunBriefEntry,
  type TokenUsage,
} from "@promptgraph/shared";
import type { EventBus } from "../events/bus.js";
import { git } from "../git/exec.js";
import { describePredecessor } from "../runners/claude/context.js";
import { runHeadless } from "../runners/claude/headless.js";
import { headlessUsage } from "../runners/git/messages.js";
import type { Store } from "../store/store.js";
import { errorMessage, truncate } from "../util/text.js";
import { INTERRUPTED_BRIEF_ERROR as BRIEF_INTERRUPTED } from "./recovery.js";
import type { RepoRef } from "../workspace/lane-manager.js";

export interface SummarizeInput {
  prompt: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}

/** The headless call that writes one brief entry; tests inject a fake. */
export type Summarize = (input: SummarizeInput) => Promise<{ summary: BriefSummary; usage: TokenUsage | null }>;

export interface RunBrieferDeps {
  store: Store;
  bus: EventBus;
  repo: RepoRef;
  env?: NodeJS.ProcessEnv;
  summarize?: Summarize;
  /** Per summary call. Default 120 s. */
  timeoutMs?: number;
  /** `git diff --stat from to` in the main checkout; injectable for tests. */
  diffStat?: (from: string, to: string) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Earlier entries passed as context (the newest ones). */
const HISTORY_LIMIT = 30;
const OUTPUT_LIMIT = 4000;
const INSTRUCTIONS_LIMIT = 1500;
const DIFF_STAT_LIMIT = 3000;
const SUMMARY_LIMIT = 600;

const BRIEF_SYSTEM_PROMPT =
  "You write the brief of automated software runs: short, factual summaries of each step for the person who started the run. Answer only from the information given.";

/** Default Summarize: a minimal `claude -p --json-schema BRIEF_JSON_SCHEMA` (runHeadless `minimal`). @throws on bad output */
export const summarizeWithClaude: Summarize = async (input) => {
  const result = await runHeadless({
    prompt: input.prompt,
    cwd: input.cwd,
    jsonSchema: BRIEF_JSON_SCHEMA,
    model: input.model,
    minimal: { systemPrompt: BRIEF_SYSTEM_PROMPT },
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    env: input.env,
  });
  return { summary: parseSummary(result), usage: headlessUsage(result, input.model) };
};

function parseSummary(result: HeadlessResult): BriefSummary {
  let value = result.structured_output;
  if (value === undefined && result.result) {
    try {
      value = JSON.parse(result.result);
    } catch {
      // Reported below.
    }
  }
  const parsed = BriefSummarySchema.safeParse(value);
  if (!parsed.success) throw new Error("Claude did not return the summary in the expected format");
  return { title: parsed.data.title.trim(), summary: parsed.data.summary.trim() };
}

/**
 * The run brief (DESIGN §13.6): when a step of a run whose graph has `settings.brief.enabled` finishes (succeeded
 * or failed), a pending entry is recorded and a headless Claude call summarises the step in the context of the
 * entries before it; when the run ends, one more entry summarises the whole run. Calls are serial per run (each
 * entry sees the ones before it) and never block or fail the run: a failed call only marks its entry failed.
 * Every change emits `brief:update`, and `run:update` once a call's usage is recorded. Entries left pending by a
 * daemon that stopped are marked failed by markInterrupted.
 */
export class RunBriefer {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly summarize: Summarize;

  constructor(private readonly deps: RunBrieferDeps) {
    this.summarize = deps.summarize ?? summarizeWithClaude;
  }

  /** A node run reached succeeded or failed. */
  nodeFinished(runId: string, nodeRunId: string): void {
    if (this.abort.signal.aborted) return;
    const { store } = this.deps;
    const run = store.getRun(runId);
    const nodeRun = store.getNodeRun(nodeRunId);
    if (!run || !nodeRun || !run.graphSnapshot.settings.brief.enabled) return;
    const entry = store.insertBriefEntry({ runId, kind: "node", nodeRunId, nodeId: nodeRun.nodeId, outcome: nodeRun.status });
    this.emit(entry);
    this.enqueue(runId, () => this.write(entry.id));
  }

  /** The run ended: summarises it as a whole when at least one step was summarised. */
  runFinished(runId: string): void {
    if (this.abort.signal.aborted) return;
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (!run || !run.graphSnapshot.settings.brief.enabled) return;
    if (!store.listBriefEntries(runId).some((e) => e.kind === "node")) return;
    const entry = store.insertBriefEntry({ runId, kind: "run", nodeRunId: null, nodeId: null, outcome: run.status });
    this.emit(entry);
    this.enqueue(runId, () => this.write(entry.id));
  }

  /** Stops the calls in progress (their entries are marked failed) and waits for the queues. */
  async shutdown(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.queues.values()]);
  }

  /** Resolves once every queued summary of the run is written (tests). */
  async idle(runId: string): Promise<void> {
    await this.queues.get(runId);
  }

  private enqueue(runId: string, job: () => Promise<void>): void {
    const next = (this.queues.get(runId) ?? Promise.resolve()).then(job).catch(() => undefined);
    this.queues.set(runId, next);
    void next.then(() => {
      if (this.queues.get(runId) === next) this.queues.delete(runId);
    });
  }

  private async write(entryId: number): Promise<void> {
    const { store } = this.deps;
    const entry = store.getBriefEntry(entryId);
    if (!entry || entry.status !== "pending") return;
    const run = store.getRun(entry.runId);
    if (!run) return;
    if (this.abort.signal.aborted) {
      this.finish(entryId, { status: "failed", error: BRIEF_INTERRUPTED });
      return;
    }
    try {
      const prompt = await this.buildPrompt(run, entry);
      const settings = run.graphSnapshot.settings.brief;
      const { summary, usage } = await this.summarize({
        prompt,
        cwd: this.deps.repo.path,
        model: settings.model?.trim() || DEFAULT_BRIEF_MODEL,
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: this.abort.signal,
        env: this.deps.env ?? process.env,
      });
      this.finish(entryId, { status: "ready", title: summary.title || "(untitled)", summary: summary.summary, error: null, usage });
    } catch (err) {
      const error = this.abort.signal.aborted ? BRIEF_INTERRUPTED : errorMessage(err);
      this.finish(entryId, { status: "failed", error });
    }
  }

  private finish(entryId: number, patch: Parameters<Store["updateBriefEntry"]>[1]): void {
    const { store, bus, repo } = this.deps;
    // The run may have been deleted meanwhile (its entries went with it).
    if (!store.getBriefEntry(entryId)) return;
    const entry = store.updateBriefEntry(entryId, patch);
    this.emit(entry);
    if (patch.usage) {
      const summary = store.getRunSummary(entry.runId);
      if (summary) bus.emit("run:update", { repoId: repo.id, run: summary });
    }
  }

  private emit(entry: RunBriefEntry): void {
    this.deps.bus.emit("brief:update", { repoId: this.deps.repo.id, entry });
  }

  private async buildPrompt(run: Run, entry: RunBriefEntry): Promise<string> {
    const { store } = this.deps;
    const graph = run.graphSnapshot;
    const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const earlier = store
      .listBriefEntries(run.id)
      .filter((e) => e.id < entry.id && e.status === "ready" && e.kind === "node")
      .slice(-HISTORY_LIMIT);
    const history =
      earlier.length > 0
        ? earlier.map((e, i) => `${i + 1}. ${e.title} (${e.outcome})\n${truncate(e.summary ?? "", SUMMARY_LIMIT)}`).join("\n\n")
        : "(nothing yet: this is the first entry)";
    const steps = graph.nodes.map((n) => `- ${nodeDisplayLabel(n)} (${n.type})`).join("\n");

    const parts = [
      "You write the brief of a promptgraph run: a timeline that tells the user, at a glance, what has happened so far.",
      `Graph: ${graph.name}\nSteps of the graph:\n${steps}`,
      `Brief so far:\n${history}`,
    ];
    if (entry.kind === "node") {
      const nodeRun = entry.nodeRunId ? store.getNodeRun(entry.nodeRunId) : undefined;
      const node = entry.nodeId ? nodes.get(entry.nodeId) : undefined;
      if (!nodeRun || !node) throw new Error("The step is no longer known");
      parts.push(await this.describeStep(node, nodeRun));
      parts.push(
        [
          "Write the next entry of the brief, about the step that just finished:",
          "- title: one line (at most 80 characters) saying what the step achieved or why it failed;",
          "- summary: 1 to 4 short sentences of Markdown: what was done, the outcome, anything the user should know or check. Do not repeat earlier entries.",
          "Write in the language of the step instructions (English when unclear). Answer only from the information above.",
        ].join("\n"),
      );
    } else {
      const current = new Map<string, NodeRun>();
      for (const nr of store.listNodeRuns(run.id)) current.set(nr.nodeId, nr);
      const results = graph.nodes.map((n) => `- ${nodeDisplayLabel(n)}: ${current.get(n.id)?.status ?? "not run"}`).join("\n");
      parts.push(`The run ended: ${run.status}${run.error ? ` (${run.error})` : ""}.\nResult of each step:\n${results}`);
      parts.push(
        [
          "Write the closing entry of the brief, about the whole run:",
          "- title: one line (at most 80 characters) with the overall result;",
          "- summary: 2 to 5 short sentences of Markdown: what the run achieved, what failed or is left to do, and what the user should look at next.",
          "Write in the language of the step instructions (English when unclear). Answer only from the information above.",
        ].join("\n"),
      );
    }
    return parts.join("\n\n");
  }

  private async describeStep(node: GraphNode, nr: NodeRun): Promise<string> {
    const lines = [`The step that just finished: ${nodeDisplayLabel(node)} (${node.type}), result: ${nr.status}`];
    if (nr.iteration > 0 || nr.attempt > 0) lines.push(`Iteration ${nr.iteration + 1}, attempt ${nr.attempt + 1}`);
    if (nr.startedAt && nr.finishedAt) lines.push(`Duration: ${Math.round((nr.finishedAt - nr.startedAt) / 1000)} s`);
    const instructions = nodeInstructions(node);
    if (instructions) lines.push(`Instructions:\n${truncate(instructions, INSTRUCTIONS_LIMIT)}`);
    const result = describePredecessor({
      nodeId: node.id,
      label: nodeDisplayLabel(node),
      type: node.type,
      status: nr.status,
      output: nr.output,
      error: nr.error,
      sessionId: nr.sessionId,
      transcriptPath: nr.transcriptPath,
      laneId: nr.laneId,
    });
    lines.push(`Result:\n${truncate(result, OUTPUT_LIMIT)}`);
    const stat = nr.snapshotStart && nr.snapshotEnd ? await this.diffStat(nr.snapshotStart, nr.snapshotEnd) : "";
    lines.push(stat ? `Files changed by the step:\n${truncate(stat, DIFF_STAT_LIMIT)}` : "Files changed by the step: none recorded");
    return lines.join("\n");
  }

  private async diffStat(from: string, to: string): Promise<string> {
    if (from === to) return "";
    try {
      if (this.deps.diffStat) return (await this.deps.diffStat(from, to)).trim();
      const res = await git(this.deps.repo.path, ["diff", "--stat", from, to], { readOnly: true, maxStdoutBytes: 64 * 1024 });
      return res.code === 0 ? res.stdout.trim() : "";
    } catch {
      return "";
    }
  }
}

/** The text that tells what a node was asked to do. */
function nodeInstructions(node: GraphNode): string {
  switch (node.type) {
    case "prompt":
      return node.config.prompt;
    case "command":
      return node.config.command;
    case "shell":
      return `$ ${node.config.run}`;
    case "approval":
      return node.config.message ?? "";
    case "linear":
      return node.config.prompt ?? "Update the linked Linear issues";
    default:
      return "";
  }
}
