import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_MESSAGE_JSON_SCHEMA } from "@promptgraph/shared";
import { runHeadless } from "../src/runners/claude/headless.js";
import { buildMessagePrompt, generateMessage } from "../src/runners/git/messages.js";
import { fakeClaudeEnv, tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function env(extra: Record<string, string> = {}) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { dir: t.dir, env: { ...process.env, ...fakeClaudeEnv(t.dir), ...extra } };
}

describe("runHeadless", () => {
  it("returns the parsed envelope with structured output", async () => {
    const { dir, env: e } = env();
    const r = await runHeadless({ prompt: "msg", cwd: dir, jsonSchema: GENERATED_MESSAGE_JSON_SCHEMA, model: "haiku", env: e });
    expect(r.structured_output).toEqual({ title: "fake title", body: "fake body" });
    expect(r.is_error).toBe(false);
    expect(Object.keys(r.modelUsage ?? {})).toEqual(["claude-haiku-5-5"]);
  });

  it("throws on is_error, a missing binary, timeout and abort", async () => {
    const { dir, env: e } = env();
    await expect(runHeadless({ prompt: "x [[fail]]", cwd: dir, env: e })).rejects.toThrow(/error/);
    await expect(runHeadless({ prompt: "x", cwd: dir, env: { ...e, PG_CLAUDE_BIN: path.join(dir, "missing") } })).rejects.toThrow();
    await expect(runHeadless({ prompt: "x", cwd: dir, timeoutMs: 50, env: { ...e, FAKE_CLAUDE_DELAY_MS: "5000" } })).rejects.toThrow(/timed out/);
    const ac = new AbortController();
    const p = runHeadless({ prompt: "x", cwd: dir, signal: ac.signal, env: { ...e, FAKE_CLAUDE_DELAY_MS: "5000" } });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

describe("generateMessage", () => {
  it("builds a prompt from the diff stat and outputs", () => {
    const prompt = buildMessagePrompt({
      cwd: "/",
      kind: "pr",
      diffStat: " a.ts | 2 +-",
      outputs: [{ nodeId: "n", label: "Fix", type: "shell", status: "succeeded", output: { exitCode: 0, stdoutTail: "ok" }, error: null, sessionId: null, laneId: null }],
    });
    expect(prompt).toContain("pull request");
    expect(prompt).toContain("a.ts | 2 +-");
    expect(prompt).toContain("### Fix (shell)\nExit code: 0");
  });

  it("uses structured output and envelope cost; pr fallback lists the steps", async () => {
    const { dir, env: e } = env();
    const ok = await generateMessage({ cwd: dir, kind: "pr", diffStat: "x", outputs: [], env: e });
    expect(ok).toMatchObject({ title: "fake title", body: "fake body", usage: { costUsd: 0.0123, model: "claude-opus-5-5" } });
    const failing = await generateMessage({
      cwd: dir,
      kind: "pr",
      diffStat: " a | 1 +",
      outputs: [{ nodeId: "n", label: "Build", type: "prompt", status: "succeeded", output: null, error: null, sessionId: null, laneId: null }],
      env: { ...e, FAKE_CLAUDE_MODE: "fail" },
    });
    expect(failing).toEqual({ title: "Changes from promptgraph", body: "Steps:\n- Build\n\n```\na | 1 +\n```", usage: null });
  });
});
