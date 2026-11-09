import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LINEAR_UPDATE_PROMPT, type GraphIssue, type LinearUpdateSuggestion } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearIssueContext } from "../src/linear/client.js";
import { buildLinearPrompt, buildProposals, decisionsToApply, LinearUpdateRunner, type LinearWriter, type Propose } from "../src/runners/linear-runner.js";
import { createTempRepo, waitFor } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const STATES = [
  { id: "s-todo", name: "Todo", type: "unstarted", color: "#ccc" },
  { id: "s-prog", name: "In Progress", type: "started", color: "#fc0" },
  { id: "s-review", name: "In Review", type: "started", color: "#0cf" },
  { id: "s-done", name: "Done", type: "completed", color: "#0c0" },
];

const ctxOf = (n: number, state = STATES[0]!): LinearIssueContext => ({
  issueId: `i${n}`,
  identifier: `ENG-${n}`,
  title: `Issue ${n}`,
  url: `https://linear.app/acme/issue/ENG-${n}`,
  description: `Description ${n}`,
  currentState: state,
  states: STATES,
});
const linkOf = (n: number): GraphIssue => ({ provider: "linear", id: `i${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, url: `https://linear.app/acme/issue/ENG-${n}` });

const ALL = { allowComments: true, allowStateChanges: true };

describe("linear node helpers (§24.5)", () => {
  it("builds one proposal per issue from Claude's suggestion, matching states by name", () => {
    const suggestion: LinearUpdateSuggestion = {
      updates: [
        { identifier: "eng-1", comment: " Implemented the API. ", state: "in review" },
        { identifier: "ENG-2", comment: "", state: "Todo" }, // already Todo: no change
        { identifier: "ENG-9", comment: "unknown issue", state: "Done" },
        { identifier: "ENG-3", comment: "", state: "Shipped" }, // unknown state
      ],
    };
    const proposals = buildProposals([ctxOf(1), ctxOf(2), ctxOf(3)], suggestion, ALL);
    expect(proposals.map((p) => [p.identifier, p.comment, p.stateId])).toEqual([
      ["ENG-1", "Implemented the API.", "s-review"],
      ["ENG-2", "", null],
      ["ENG-3", "", null],
    ]);
    const commentsOnly = buildProposals([ctxOf(1)], suggestion, { allowComments: true, allowStateChanges: false });
    expect(commentsOnly[0]).toMatchObject({ comment: "Implemented the API.", stateId: null });
    const statesOnly = buildProposals([ctxOf(1)], suggestion, { allowComments: false, allowStateChanges: true });
    expect(statesOnly[0]).toMatchObject({ comment: "", stateId: "s-review" });
  });

  it("applies the dialog's edits, dropping what was not proposed, invalid states and disallowed kinds", () => {
    const proposals = buildProposals([ctxOf(1), ctxOf(2)], { updates: [{ identifier: "ENG-1", comment: "c1", state: "In Progress" }] }, ALL);
    expect(decisionsToApply(proposals, {}, ALL).map((d) => [d.proposal.identifier, d.comment, d.stateId])).toEqual([["ENG-1", "c1", "s-prog"]]);
    const edited = decisionsToApply(
      proposals,
      {
        linearUpdates: [
          { issueId: "i2", comment: " added by hand ", stateId: "s-done" },
          { issueId: "i1", comment: "", stateId: "not-a-state" },
          { issueId: "i9", comment: "not proposed", stateId: null },
          { issueId: "i2", comment: "duplicate", stateId: null },
        ],
      },
      ALL,
    );
    expect(edited.map((d) => [d.proposal.identifier, d.comment, d.stateId])).toEqual([["ENG-2", "added by hand", "s-done"]]);
    expect(decisionsToApply(proposals, { linearUpdates: [{ issueId: "i1", comment: "x", stateId: "s-done" }] }, { allowComments: false, allowStateChanges: true })[0]).toMatchObject({
      comment: "",
      stateId: "s-done",
    });
  });

  it("puts the instructions, the issues with their allowed states and the run's work in the prompt", () => {
    const prompt = buildLinearPrompt({
      instructions: DEFAULT_LINEAR_UPDATE_PROMPT,
      issues: [ctxOf(1, STATES[1])],
      ...ALL,
      diffStat: " src/a.ts | 3 ++-",
      commits: ["feat: add a"],
      outputs: [
        { nodeId: "p", label: "Implement", type: "prompt", status: "succeeded", output: { text: "Done: added a" }, error: null, sessionId: null, transcriptPath: null, laneId: "main" },
      ],
    });
    expect(prompt.startsWith(DEFAULT_LINEAR_UPDATE_PROMPT)).toBe(true);
    for (const part of ["### ENG-1: Issue 1", "Current state: In Progress", "Allowed states: Todo, In Progress, In Review, Done", "Description 1", "src/a.ts", "- feat: add a", "Done: added a"]) {
      expect(prompt).toContain(part);
    }
  });
});

describe("LinearUpdateRunner (§24.5)", () => {
  function setup(issues: GraphIssue[], config: Record<string, unknown> = {}, propose?: Propose) {
    const r = createTempRepo();
    cleanups.push(r.cleanup);
    fs.writeFileSync(path.join(r.repo, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: r.repo });
    execFileSync("git", ["commit", "-qm", "feat: add a"], { cwd: r.repo });
    const writes: string[] = [];
    const linear: LinearWriter = {
      issueContext: vi.fn(async (ids: readonly string[]) => ids.map((id) => ctxOf(Number(id.slice(1))))),
      comment: vi.fn(async (issueId: string, body: string) => {
        if (issueId === "i3") throw new Error("Linear rejected the API key");
        writes.push(`comment ${issueId}: ${body}`);
      }),
      setState: vi.fn(async (issueId: string, stateId: string) => void writes.push(`state ${issueId}: ${stateId}`)),
    };
    const prompts: string[] = [];
    const fake: Propose =
      propose ??
      (async (input) => {
        prompts.push(input.prompt);
        return {
          suggestion: { updates: issues.map((i) => ({ identifier: i.identifier, comment: `Progress on ${i.identifier}`, state: "In Review" })) },
          usage: null,
        };
      });
    const run = makeRun({ issues, nodes: [{ id: "lin", type: "linear", label: "Update Linear", config } as never] }, r.repo);
    // No such base branch: the diff falls back to the lane's base (the commit before "feat: add a").
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(r.repo, "HEAD~1"), baseBranch: "no-such-branch" });
    const exec = new LinearUpdateRunner({ linear, propose: fake }).start(ctx);
    return { ctx, exec, writes, prompts, linear };
  }

  it("proposes, waits for approval, then comments and moves each issue", async () => {
    const { ctx, exec, writes, prompts } = setup([linkOf(1), linkOf(2)], { prompt: "Custom instructions" });
    await waitFor(() => ctx.current.status === "waiting_approval");
    expect(prompts[0]!.startsWith("Custom instructions")).toBe(true);
    expect(prompts[0]).toContain("a.ts");
    expect(ctx.current.output?.linear?.proposals.map((p) => [p.identifier, p.comment, p.stateId])).toEqual([
      ["ENG-1", "Progress on ENG-1", "s-review"],
      ["ENG-2", "Progress on ENG-2", "s-review"],
    ]);
    expect(writes).toEqual([]);

    exec.controls.approve!({ approved: true, linearUpdates: [{ issueId: "i2", comment: "Edited", stateId: null }] });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { approved: true, text: "ENG-2: commented" } });
    expect(writes).toEqual(["comment i2: Edited"]);
    expect(result.output?.linear?.results).toEqual([{ identifier: "ENG-2", commented: true, movedTo: null, error: null }]);
  });

  it("uses the default prompt and applies the proposal as is when approved without edits", async () => {
    const { ctx, exec, writes, prompts } = setup([linkOf(1)]);
    await waitFor(() => ctx.current.status === "waiting_approval");
    expect(prompts[0]!.startsWith(DEFAULT_LINEAR_UPDATE_PROMPT)).toBe(true);
    exec.controls.approve!({ approved: true });
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { text: "ENG-1: commented, moved to In Review" } });
    expect(writes).toEqual(["comment i1: Progress on ENG-1", "state i1: s-review"]);
  });

  it("rejection fails without writing anything", async () => {
    const { ctx, exec, writes } = setup([linkOf(1)]);
    await waitFor(() => ctx.current.status === "waiting_approval");
    exec.controls.approve!({ approved: false, comment: "too early" });
    expect(await exec.result).toMatchObject({ status: "failed", error: "Linear update rejected: too early" });
    expect(writes).toEqual([]);
  });

  it("continues past a failed issue and fails the node naming it", async () => {
    const { ctx, exec, writes } = setup([linkOf(3), linkOf(1)], { allowStateChanges: false });
    await waitFor(() => ctx.current.status === "waiting_approval");
    exec.controls.approve!({ approved: true });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", error: "Linear update failed for ENG-3: Linear rejected the API key" });
    expect(writes).toEqual(["comment i1: Progress on ENG-1"]);
    expect(result.output?.linear?.results?.map((r) => [r.identifier, r.commented, r.error])).toEqual([
      ["ENG-3", false, "Linear rejected the API key"],
      ["ENG-1", true, null],
    ]);
  });

  it("succeeds without asking when no issue is linked or nothing is proposed", async () => {
    const none = setup([]);
    expect(await none.exec.result).toMatchObject({ status: "succeeded", output: { text: "No Linear issues are linked to this graph." } });
    expect(none.linear.issueContext).not.toHaveBeenCalled();
    const quiet = setup([linkOf(1)], {}, async () => ({ suggestion: { updates: [] }, usage: null }));
    expect(await quiet.exec.result).toMatchObject({ status: "succeeded", output: { text: "Claude proposed no Linear updates." } });
    expect(quiet.ctx.patches.some((p) => p.status === "waiting_approval")).toBe(false);
  });

  it("fails with the error when the proposal cannot be made", async () => {
    const { exec, writes } = setup([linkOf(1)], {}, async () => {
      throw new Error("claude -p timed out after 300000 ms");
    });
    expect(await exec.result).toMatchObject({ status: "failed", error: "claude -p timed out after 300000 ms" });
    expect(writes).toEqual([]);
  });

  it("cancel while waiting ends the node without writing", async () => {
    const { ctx, exec, writes } = setup([linkOf(1)]);
    await waitFor(() => ctx.current.status === "waiting_approval");
    await exec.controls.cancel();
    expect(await exec.result).toEqual({ status: "cancelled" });
    expect(writes).toEqual([]);
  });
});
