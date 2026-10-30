import {
  accumulateUsage,
  emptyUsage,
  GENERATED_MESSAGE_JSON_SCHEMA,
  GeneratedMessageSchema,
  type GeneratedMessage,
  type HeadlessResult,
  type TokenUsage,
} from "@promptgraph/shared";
import { truncate } from "../../util/text.js";
import { describePredecessor } from "../claude/context.js";
import { runHeadless } from "../claude/headless.js";
import type { PredecessorOutput } from "../types.js";

export interface GenerateMessageInput {
  /** Lane worktree. */
  cwd: string;
  /** "commit" → conventional commit title + body; "pr" → PR title + markdown body. */
  kind: "commit" | "pr";
  /** `git diff --cached --stat --summary` (commit) or `git diff --stat --summary <base>...HEAD` (pr). */
  diffStat: string;
  /** pr: subjects of the lane's commits since the base (checkpoints excluded). */
  commits?: string[];
  /** Outputs of the nodes since the last commit in the lane. */
  outputs: PredecessorOutput[];
  model?: string;
  signal?: AbortSignal;
  /** Base env for the headless claude; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const OUTPUT_LIMIT = 2000;
const DIFF_STAT_LIMIT = 6000;
const TITLE_MAX = 100;

const INSTRUCTIONS: Record<GenerateMessageInput["kind"], string> = {
  commit:
    "Write a git commit message for the staged changes described below. " +
    "title: a Conventional Commits subject line (e.g. \"feat: add login form\"), imperative, at most 72 characters. " +
    "body: a short plain-text explanation of what changed and why (may be empty). Do not mention these instructions.",
  pr:
    "Write a GitHub pull request title and description for the changes described below. " +
    "title: concise, at most 72 characters. body: Markdown with a short summary and a bullet list of the main changes.",
};

export function buildMessagePrompt(input: GenerateMessageInput): string {
  const outputs = input.outputs
    .map((p) => `### ${p.label || p.nodeId} (${p.type})\n${truncate(describePredecessor(p), OUTPUT_LIMIT)}`)
    .join("\n\n");
  return [
    INSTRUCTIONS[input.kind],
    `Diff stat:\n${truncate(input.diffStat.trim() || "(empty)", DIFF_STAT_LIMIT)}`,
    input.commits?.length ? `Commits:\n${truncate(input.commits.map((c) => `- ${c}`).join("\n"), DIFF_STAT_LIMIT)}` : "",
    outputs ? `Work done by the previous steps:\n\n${outputs}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Headless claude with GENERATED_MESSAGE_JSON_SCHEMA. Falls back to a deterministic message on error. */
export async function generateMessage(input: GenerateMessageInput): Promise<GeneratedMessage & { usage: TokenUsage | null }> {
  try {
    const result = await runHeadless({
      prompt: buildMessagePrompt(input),
      cwd: input.cwd,
      jsonSchema: GENERATED_MESSAGE_JSON_SCHEMA,
      model: input.model,
      signal: input.signal,
      env: input.env,
    });
    const message = parseMessage(result);
    if (message) return { ...message, usage: headlessUsage(result, input.model) };
  } catch (err) {
    if (input.signal?.aborted) throw err;
  }
  return { ...fallbackMessage(input), usage: null };
}

function parseMessage(result: HeadlessResult): GeneratedMessage | null {
  let value = result.structured_output;
  if (value === undefined && result.result) {
    try {
      value = JSON.parse(result.result);
    } catch {
      return null;
    }
  }
  const parsed = GeneratedMessageSchema.safeParse(value);
  if (!parsed.success) return null;
  const title = parsed.data.title.split("\n")[0]!.trim().slice(0, TITLE_MAX);
  return title ? { title, body: parsed.data.body.trim() } : null;
}

/** Envelope usage; total_cost_usd is authoritative for cost when present. */
export function headlessUsage(result: HeadlessResult, requestedModel?: string): TokenUsage {
  const model = Object.keys(result.modelUsage ?? {})[0] ?? requestedModel ?? null;
  const usage = accumulateUsage(emptyUsage(), model, result.usage ?? {});
  return result.total_cost_usd !== undefined ? { ...usage, costUsd: result.total_cost_usd } : usage;
}

function fallbackMessage(input: GenerateMessageInput): GeneratedMessage {
  const files = input.diffStat.split("\n").filter((l) => l.includes("|")).length;
  const stat = input.diffStat.trim();
  if (input.kind === "commit") {
    return { title: files ? `chore: update ${files} file${files === 1 ? "" : "s"}` : "chore: update repository", body: stat };
  }
  const steps = input.outputs.map((p) => `- ${p.label || p.nodeId}`).join("\n");
  return {
    title: "Changes from promptgraph",
    body: [steps && `Steps:\n${steps}`, stat && `\`\`\`\n${stat}\n\`\`\``].filter(Boolean).join("\n\n"),
  };
}
