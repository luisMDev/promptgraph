import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { validateGraph, type GraphInput, type NodeRunOutput, type NodeStatus, type NodeType } from "@promptgraph/shared";
import { buildInitialMessage } from "../src/runners/claude/context.js";
import {
  ConditionRunner,
  buildJudgePrompt,
  evaluatedPredecessor,
  laneDiffStat,
  parseJudgeVerdict,
} from "../src/runners/condition-runner.js";
import type { PredecessorOutput } from "../src/runners/types.js";
import { createTempRepo, fakeClaudeEnv, tempDir } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

function pred(output: NodeRunOutput | null, patch: Partial<PredecessorOutput> = {}): PredecessorOutput {
  return {
    nodeId: "p",
    label: "Tests",
    type: "shell" as NodeType,
    status: "succeeded" as NodeStatus,
    output,
    error: null,
    sessionId: null,
    transcriptPath: null,
    laneId: "main",
    ...patch,
  };
}

function start(evaluator: Record<string, unknown>, predecessors: PredecessorOutput[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; model?: string } = {}) {
  const run = makeRun({
    nodes: [{ id: "c", type: "condition", label: "Check", config: { evaluator } } as never],
    ...(opts.model ? { settings: { baseBranch: "main", defaults: { model: opts.model } } as never } : {}),
  });
  const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(opts.cwd ?? "/tmp"), predecessors });
  const exec = new ConditionRunner({ env: opts.env }).start(ctx);
  return { ctx, exec };
}

function fakeEnv(extra: Record<string, string> = {}) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const promptLog = path.join(t.dir, "prompts.jsonl");
  return {
    dir: t.dir,
    promptLog,
    prompts: () =>
      fs.existsSync(promptLog)
        ? fs.readFileSync(promptLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; prompt: string; cwd: string })
        : [],
    env: { ...process.env, ...fakeClaudeEnv(t.dir), FAKE_CLAUDE_PROMPT_LOG: promptLog, ...extra },
  };
}

describe("ConditionRunner exitCode", () => {
  it("routes to true when the exit code equals (default 0) and copies the evaluated output", async () => {
    const { exec, ctx } = start({ kind: "exitCode" }, [pred({ exitCode: 0, stdoutTail: "all green" })]);
    expect(await exec.result).toEqual({
      status: "succeeded",
      output: { result: true, port: "true", text: "Exit code 0 equals 0.", exitCode: 0, stdoutTail: "all green" },
    });
    expect(ctx.events).toEqual([{ type: "condition:evaluated", payload: { kind: "exitCode", result: true, predecessor: "p" } }]);
  });

  it("routes to false otherwise; a failed shell predecessor is evaluated too", async () => {
    const { exec } = start({ kind: "exitCode", equals: 0 }, [pred({ exitCode: 1, stdoutTail: "1 failing" }, { status: "failed", error: "Exit code 1" })]);
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { result: false, port: "false", exitCode: 1, stdoutTail: "1 failing" } });
    const custom = start({ kind: "exitCode", equals: 2 }, [pred({ exitCode: 2 })]);
    expect(await custom.exec.result).toMatchObject({ output: { port: "true" } });
  });

  it("null exit code (timeout) is false; a predecessor without exit code fails clearly", async () => {
    const timedOut = start({ kind: "exitCode" }, [pred({ exitCode: null, timedOut: true })]);
    expect(await timedOut.exec.result).toMatchObject({ status: "succeeded", output: { port: "false", text: expect.stringContaining("timed out") } });
    const prompt = start({ kind: "exitCode" }, [pred({ text: "hi" }, { type: "prompt", label: "Impl" })]);
    expect(await prompt.exec.result).toEqual({
      status: "failed",
      error: 'Exit-code condition: predecessor "Impl" (prompt) has no exit code; connect a shell node',
    });
  });

  it("fails without a predecessor that ran", async () => {
    expect(await start({ kind: "exitCode" }, []).exec.result).toEqual({ status: "failed", error: "Condition node has no predecessor to evaluate" });
    expect(await start({ kind: "exitCode" }, [pred(null, { status: "skipped" })]).exec.result).toEqual({
      status: "failed",
      error: 'No predecessor output to evaluate ("Tests" is skipped)',
    });
  });
});

describe("ConditionRunner regex", () => {
  it("tests the predecessor text with flags", async () => {
    const yes = start({ kind: "regex", pattern: "blocking", flags: "i" }, [pred({ text: "Found 2 BLOCKING issues" }, { type: "command" })]);
    expect(await yes.exec.result).toEqual({
      status: "succeeded",
      output: { result: true, port: "true", text: '/blocking/i matched "BLOCKING" in the output of "Tests".' },
    });
    const no = start({ kind: "regex", pattern: "blocking", flags: "" }, [pred({ text: "Found 2 BLOCKING issues" })]);
    expect(await no.exec.result).toMatchObject({ output: { result: false, port: "false" } });
  });

  it("falls back to the stdout tail, then the error", async () => {
    const tail = start({ kind: "regex", pattern: "^\\d+ passed$", flags: "m" }, [pred({ exitCode: 0, stdoutTail: "x\n12 passed\n" })]);
    expect(await tail.exec.result).toMatchObject({ output: { port: "true", exitCode: 0 } });
    const err = start({ kind: "regex", pattern: "timeout", flags: "" }, [pred(null, { status: "failed", error: "git push timeout" })]);
    expect(await err.exec.result).toMatchObject({ output: { port: "true" } });
  });

  it("a global regex is not stateful across evaluations; invalid regex fails", async () => {
    const ev = { kind: "regex", pattern: "a", flags: "g" };
    expect(await start(ev, [pred({ text: "a" })]).exec.result).toMatchObject({ output: { port: "true" } });
    expect(await start(ev, [pred({ text: "a" })]).exec.result).toMatchObject({ output: { port: "true" } });
    const bad = await start({ kind: "regex", pattern: "(", flags: "" }, [pred({ text: "a" })]).exec.result;
    expect(bad).toMatchObject({ status: "failed", error: expect.stringMatching(/^Invalid regex: /) });
  });
});

describe("ConditionRunner judge (fake claude)", () => {
  function repoWithChange() {
    const r = createTempRepo();
    cleanups.push(r.cleanup);
    fs.writeFileSync(path.join(r.repo, "README.md"), "changed\n");
    fs.writeFileSync(path.join(r.repo, "new.txt"), "new\n");
    return r.repo;
  }

  it("asks headless claude with the question, predecessor output and diff stat", async () => {
    const repo = repoWithChange();
    const f = fakeEnv();
    const { exec } = start({ kind: "judge", question: "Did the review report any blocking issue?" }, [pred({ text: "Review: nothing serious." }, { type: "command", label: "Review" })], {
      cwd: repo,
      env: f.env,
      model: "sonnet",
    });
    const res = await exec.result;
    expect(res).toMatchObject({ status: "succeeded", output: { result: true, port: "true", text: "fake reason", usage: { costUsd: 0.0123, model: "claude-sonnet-5-5" } } });
    const [call] = f.prompts();
    expect(call!.cwd).toBe(fs.realpathSync(repo));
    expect(call!.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--json-schema", "--model", "sonnet"]));
    expect(call!.prompt).toContain("Question: Did the review report any blocking issue?");
    expect(call!.prompt).toContain('Output of the previous step "Review" (command, succeeded):\nReview: nothing serious.');
    expect(call!.prompt).toMatch(/README\.md \| +\d/);
    expect(call!.prompt).toContain("Untracked files:\n new.txt");
  });

  it("false verdicts route to the false port; evaluator model overrides the default", async () => {
    const repo = repoWithChange();
    const f = fakeEnv();
    const { exec } = start({ kind: "judge", question: "Pass?", model: "haiku" }, [pred({ text: "[[judge:false]] broken" }, { type: "prompt" })], {
      cwd: repo,
      env: f.env,
      model: "sonnet",
    });
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { result: false, port: "false", usage: { model: "claude-haiku-5-5" } } });
    expect(f.prompts()[0]!.argv).toEqual(expect.arrayContaining(["--model", "haiku"]));
  });

  it("reads a verdict from the result text when structured output is missing", async () => {
    const f = fakeEnv({ FAKE_CLAUDE_RESULT: 'Sure.\n```json\n{"pass": "no", "reason": "Two blocking issues."}\n```' });
    const { exec } = start({ kind: "judge", question: "OK?" }, [pred({ text: "x" })], { cwd: repoWithChange(), env: f.env });
    expect(await exec.result).toMatchObject({ output: { result: false, port: "false", text: "Two blocking issues." } });
  });

  it("fails on an unparsable verdict, a headless error and a timeout", async () => {
    const repo = repoWithChange();
    const junk = start({ kind: "judge", question: "OK?" }, [pred({ text: "x" })], { cwd: repo, env: fakeEnv({ FAKE_CLAUDE_RESULT: "I cannot tell." }).env });
    expect(await junk.exec.result).toEqual({ status: "failed", error: "Judge returned no verdict: I cannot tell." });
    const failing = start({ kind: "judge", question: "OK?" }, [pred({ text: "x" })], { cwd: repo, env: fakeEnv({ FAKE_CLAUDE_MODE: "fail" }).env });
    expect(await failing.exec.result).toMatchObject({ status: "failed", error: expect.stringContaining("claude -p error") });
    const slow = start({ kind: "judge", question: "OK?", timeoutSec: 1 }, [pred({ text: "x" })], { cwd: repo, env: fakeEnv({ FAKE_CLAUDE_DELAY_MS: "5000" }).env });
    expect(await slow.exec.result).toEqual({ status: "failed", error: "claude -p timed out after 1000 ms" });
  });

  it("cancel → cancelled, fail() → failed with the reason", async () => {
    const repo = repoWithChange();
    const slowEnv = () => fakeEnv({ FAKE_CLAUDE_DELAY_MS: "5000" }).env;
    const c = start({ kind: "judge", question: "OK?" }, [pred({ text: "x" })], { cwd: repo, env: slowEnv() });
    await c.exec.controls.cancel();
    expect(await c.exec.result).toEqual({ status: "cancelled" });
    const f = start({ kind: "judge", question: "OK?" }, [pred({ text: "x" })], { cwd: repo, env: slowEnv() });
    f.exec.controls.fail("nope");
    expect(await f.exec.result).toEqual({ status: "failed", error: "nope" });
  });
});

describe("condition helpers", () => {
  it("parseJudgeVerdict handles structured, bare, embedded and invalid answers", () => {
    expect(parseJudgeVerdict({ structured_output: { pass: true, reason: "ok" } })).toEqual({ pass: true, reason: "ok" });
    expect(parseJudgeVerdict({ result: '{"pass":false,"reason":"r"}' })).toEqual({ pass: false, reason: "r" });
    expect(parseJudgeVerdict({ result: 'Answer: {"pass": "yes"} done' })).toEqual({ pass: true, reason: "" });
    expect(parseJudgeVerdict({ structured_output: { pass: "maybe" }, result: "nothing" })).toBeNull();
    expect(parseJudgeVerdict({})).toBeNull();
  });

  it("evaluatedPredecessor picks the first predecessor that ran (exclusive joins)", () => {
    const a = pred(null, { nodeId: "a", status: "skipped" });
    const b = pred({ exitCode: 1 }, { nodeId: "b", status: "failed" });
    expect(evaluatedPredecessor([a, b]).nodeId).toBe("b");
  });

  it("buildJudgePrompt truncates and marks an empty diff", () => {
    const prompt = buildJudgePrompt(" Q? ", pred({ text: "y".repeat(9000) }), "");
    expect(prompt).toContain("Question: Q?");
    expect(prompt).toContain("[truncated");
    expect(prompt).toContain("(no changes)");
  });

  it("laneDiffStat diffs against the merge-base, incl. commits and untracked files; errors are inlined", async () => {
    const r = createTempRepo();
    cleanups.push(r.cleanup);
    execFileSync("git", ["checkout", "-q", "-b", "lane"], { cwd: r.repo });
    fs.writeFileSync(path.join(r.repo, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: r.repo });
    execFileSync("git", ["commit", "-q", "-m", "a"], { cwd: r.repo });
    fs.writeFileSync(path.join(r.repo, "b.txt"), "b\n");
    const stat = await laneDiffStat(r.repo, "main", "HEAD");
    expect(stat).toMatch(/a\.txt \| 1 \+/);
    expect(stat).toContain("create mode 100644 a.txt");
    expect(stat).toContain("Untracked files:\n b.txt");
    expect(await laneDiffStat("/nonexistent-dir-pg", "main", "HEAD")).toMatch(/^\(diff unavailable: /);
  });

  it("the condition result and reason reach the successor's context block", () => {
    const run = makeRun({ nodes: [{ id: "fix", type: "prompt", label: "Fix", config: { prompt: "Fix it" } } as never] });
    const message = buildInitialMessage(
      run.graphSnapshot.nodes[0] as never,
      [pred({ result: false, port: "false", text: "Exit code 1 does not equal 0.", exitCode: 1, stdoutTail: "FAIL a.test.ts" }, { type: "condition", label: "Green?" })],
      { mode: "auto", graceSec: 5 },
    );
    expect(message).toContain("### Green? (condition, succeeded)\nCondition result: false\nExit code 1 does not equal 0.\nExit code: 1\nOutput (tail):\nFAIL a.test.ts");
  });
});

describe("validation (shared)", () => {
  function graph(evaluator: Record<string, unknown>, sourceType: string): GraphInput {
    return {
      version: 1,
      id: "g",
      name: "G",
      nodes: [
        { id: "s", type: sourceType, label: "S", position: { x: 0, y: 0 }, config: sourceType === "shell" ? { run: "true" } : { prompt: "p" } },
        { id: "c", type: "condition", label: "C", position: { x: 0, y: 100 }, config: { evaluator } },
      ],
      edges: [{ id: "e", source: "s", target: "c" }],
    } as GraphInput;
  }
  const errors = async (g: GraphInput) => {
    const { GraphSchema } = await import("@promptgraph/shared");
    return validateGraph(GraphSchema.parse(g), { phase: 2 }).errors.map((e) => e.message);
  };

  it("exitCode needs a shell predecessor; regex must compile", async () => {
    expect(await errors(graph({ kind: "exitCode" }, "shell"))).toEqual([]);
    expect(await errors(graph({ kind: "exitCode" }, "prompt"))).toEqual(["An exit-code condition needs a shell predecessor."]);
    expect((await errors(graph({ kind: "regex", pattern: "(", flags: "" }, "prompt")))[0]).toMatch(/^Invalid regex: /);
    expect(await errors(graph({ kind: "regex", pattern: "x", flags: "q" }, "prompt"))).toHaveLength(1);
  });
});
