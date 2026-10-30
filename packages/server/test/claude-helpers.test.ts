import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { costFromUsage, GraphSchema, type ClaudeNode } from "@promptgraph/shared";
import { getPaths, PG_HOOK_SOURCE } from "../src/config/paths.js";
import { buildClaudeArgs, toCliPermissionMode } from "../src/runners/claude/args.js";
import { CompletionController } from "../src/runners/claude/completion.js";
import { buildInitialMessage, CONTEXT_OUTPUT_LIMIT, markerInstruction } from "../src/runners/claude/context.js";
import { buildHooksSettings, writeHooksSettings } from "../src/runners/claude/hooks-settings.js";
import { installPgHook } from "../src/runners/claude/pg-hook.js";
import { lastAssistantText, usageFromTranscript, waitForLastAssistantText } from "../src/runners/claude/transcript.js";
import { preTrustDirectory, TRUST_DIALOG_PATTERN } from "../src/runners/claude/trust.js";
import type { PredecessorOutput } from "../src/runners/types.js";
import { stripAnsi } from "../src/util/text.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  vi.useRealTimers();
});
function tmp() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

function claudeNode(input: Record<string, unknown>): ClaudeNode {
  const g = GraphSchema.parse({ version: 1, id: "g", name: "g", nodes: [{ id: "n1", label: "Step", ...input }] });
  return g.nodes[0] as ClaudeNode;
}

const pred = (p: Partial<PredecessorOutput>): PredecessorOutput => ({
  nodeId: "p",
  label: "Prev",
  type: "prompt",
  status: "succeeded",
  output: null,
  error: null,
  sessionId: null,
  laneId: "main",
  ...p,
});

describe("buildClaudeArgs", () => {
  it("puts the message first and maps options", () => {
    expect(
      buildClaudeArgs({
        message: "/simplify",
        sessionId: "sid",
        name: "pg:g/Step",
        settingsPath: "/r/hooks.json",
        permissionMode: "manual",
        model: "opus",
        effort: "high",
        allowedTools: ["Bash(pnpm test:*)", "Edit"],
      }),
    ).toEqual([
      "/simplify",
      "--session-id", "sid",
      "--name", "pg:g/Step",
      "--settings", "/r/hooks.json",
      "--permission-mode", "default",
      "--model", "opus",
      "--effort", "high",
      "--allowedTools", "Bash(pnpm test:*)", "Edit",
    ]);
  });

  it("uses --resume instead of --session-id and guards a leading dash", () => {
    const args = buildClaudeArgs({ message: "-x", sessionId: "new", resumeSessionId: "old", name: "n", settingsPath: "s", permissionMode: "acceptEdits" });
    expect(args).toEqual([" -x", "--resume", "old", "--name", "n", "--settings", "s", "--permission-mode", "acceptEdits"]);
    expect(toCliPermissionMode("plan")).toBe("plan");
  });
});

describe("buildInitialMessage", () => {
  it("command nodes send the slash command only", () => {
    const node = claudeNode({ type: "command", config: { command: " /code-review high " } });
    expect(buildInitialMessage(node, [pred({ output: { text: "x" } })], { mode: "marker", token: "T" })).toBe("/code-review high");
  });

  it("fresh prompts get a truncated context block and marker instruction", () => {
    const node = claudeNode({ type: "prompt", config: { prompt: "Fix it" } });
    const long = "a".repeat(CONTEXT_OUTPUT_LIMIT + 100);
    const msg = buildInitialMessage(
      node,
      [
        pred({ label: "Plan", output: { text: long } }),
        pred({ label: "Tests", type: "shell", status: "failed", error: "Exited with code 1", output: { exitCode: 1, stdoutTail: "FAIL x" } }),
      ],
      { mode: "marker", token: "<<DONE>>" },
    );
    expect(msg.startsWith("Context from previous steps:")).toBe(true);
    expect(msg).toContain("### Plan (prompt, succeeded)");
    expect(msg).toContain("[truncated 100 chars]");
    expect(msg).not.toContain("a".repeat(CONTEXT_OUTPUT_LIMIT + 1));
    expect(msg).toContain("Error: Exited with code 1\nExit code: 1\nOutput (tail):\nFAIL x");
    expect(msg).toContain("---\n\nFix it\n\n" + markerInstruction("<<DONE>>"));
  });

  it("clean and resume prompts are the prompt only", () => {
    for (const context of ["clean", "resume"]) {
      const node = claudeNode({ type: "prompt", config: { prompt: "Go", context } });
      expect(buildInitialMessage(node, [pred({ output: { text: "x" } })], { mode: "auto", graceSec: 5 })).toBe("Go");
    }
  });
});

describe("hooks settings and pg-hook", () => {
  it("builds one quoted command per hook event and writes idempotently", () => {
    const s = buildHooksSettings("/opt/my dir/pg-hook");
    expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "PreToolUse", "SessionStart", "Stop"]);
    expect(s.hooks.Stop![0]!.hooks[0]!.command).toBe("'/opt/my dir/pg-hook' stop");
    expect(s.hooks.PreToolUse![0]!.hooks[0]!.command).toBe("'/opt/my dir/pg-hook' activity");
    const file = path.join(tmp(), "runs", "r1", "hooks.json");
    expect(writeHooksSettings(file, "/x/pg-hook")).toBe(file);
    const mtime = fs.statSync(file).mtimeMs;
    writeHooksSettings(file, "/x/pg-hook");
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(buildHooksSettings("/x/pg-hook"));
  });

  it("installs pg-hook as an executable copy", () => {
    const paths = getPaths({ PG_HOME: tmp() });
    const target = installPgHook(paths);
    expect(target).toBe(path.join(paths.binDir, "pg-hook"));
    expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(PG_HOOK_SOURCE, "utf8"));
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    fs.writeFileSync(target, "old");
    installPgHook(paths);
    expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(PG_HOOK_SOURCE, "utf8"));
  });
});

describe("preTrustDirectory", () => {
  it("creates the config when missing and keeps other fields", async () => {
    const dir = tmp();
    const env = { CLAUDE_CONFIG_DIR: path.join(dir, "cfg") };
    await preTrustDirectory("/work/a", env);
    const file = path.join(dir, "cfg", ".claude.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ projects: { "/work/a": { hasTrustDialogAccepted: true } } });

    fs.writeFileSync(file, JSON.stringify({ theme: "dark", projects: { "/work/b": { allowedTools: ["x"] } } }));
    await Promise.all(["/work/b", "/work/c", "/work/d"].map((d) => preTrustDirectory(d, env)));
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.projects["/work/b"]).toEqual({ allowedTools: ["x"], hasTrustDialogAccepted: true });
    expect(cfg.projects["/work/c"].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects["/work/d"].hasTrustDialogAccepted).toBe(true);
    expect(fs.readdirSync(path.join(dir, "cfg"))).toEqual([".claude.json"]);
  });

  it("refuses to overwrite an unparsable config", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".claude.json"), "{oops");
    await expect(preTrustDirectory("/w", { CLAUDE_CONFIG_DIR: dir })).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, ".claude.json"), "utf8")).toBe("{oops");
  });

  it("the dialog pattern matches ANSI-laden TUI output", () => {
    const tui = "\x1b[1mDo\x1b[1Cyou trust the\r\n files in this folder?\x1b[0m";
    expect(TRUST_DIALOG_PATTERN.test(stripAnsi(tui).replace(/\s+/g, ""))).toBe(true);
  });
});

describe("transcript", () => {
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 };
  function write(lines: unknown[], partial = "") {
    const file = path.join(tmp(), "t.jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + partial);
    return file;
  }

  it("reads the last assistant text and sums usage deduplicated by message.id", () => {
    const file = write(
      [
        { type: "user", message: { content: "hi" } },
        { type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "…" }], usage } },
        { type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "first" }], usage } },
        { type: "assistant", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "text", text: "second" }, { type: "text", text: "part" }], usage } },
        { type: "assistant", message: { id: "m3", model: "<synthetic>", content: [{ type: "text", text: "" }], usage: { input_tokens: 0 } } },
      ],
      '{"type":"assistant","mess',
    );
    expect(lastAssistantText(file)).toBe("second\npart");
    const u = usageFromTranscript(file);
    expect(u).toMatchObject({ inputTokens: 20, outputTokens: 40, cacheCreationTokens: 200, cacheReadTokens: 400, model: "claude-opus-5-5" });
    expect(u.costUsd).toBeCloseTo(2 * costFromUsage("claude-opus-5-5", usage), 10);
  });

  it("handles missing files and waits for the assistant line", async () => {
    expect(lastAssistantText("/nope.jsonl")).toBeNull();
    expect(usageFromTranscript("/nope.jsonl").costUsd).toBe(0);
    const file = write([{ type: "user", message: { content: "q" } }]);
    setTimeout(() => fs.appendFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } }) + "\n"), 150);
    expect(await waitForLastAssistantText(file, 2000)).toBe("late");
    expect(await waitForLastAssistantText("/nope.jsonl", 150)).toBeNull();
  });
});

describe("CompletionController", () => {
  function make(policy: ConstructorParameters<typeof CompletionController>[0]) {
    const calls: string[] = [];
    const c = new CompletionController(policy, {
      succeed: () => calls.push("succeed"),
      idle: () => calls.push("idle"),
      resume: () => calls.push("resume"),
    });
    return { c, calls };
  }

  it("auto: succeeds after the grace period unless the user types", () => {
    vi.useFakeTimers();
    const { c, calls } = make({ mode: "auto", graceSec: 5 });
    c.onStop("x");
    vi.advanceTimersByTime(4000);
    c.onUserInput();
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual(["resume"]);
    c.onStop("y");
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual(["resume", "succeed"]);
    c.onStop("z");
    expect(calls).toHaveLength(2);
  });

  it("auto with graceSec 0 succeeds immediately", () => {
    const { c, calls } = make({ mode: "auto", graceSec: 0 });
    c.onStop(null);
    expect(calls).toEqual(["succeed"]);
  });

  it("manual goes idle; activity resumes", () => {
    const { c, calls } = make({ mode: "manual" });
    c.onStop("x");
    c.onActivity();
    c.onActivity();
    expect(calls).toEqual(["idle", "resume"]);
  });

  it("marker succeeds only when the token is present", () => {
    const { c, calls } = make({ mode: "marker", token: "<<PG_DONE>>" });
    c.onStop("not yet");
    c.onUserInput();
    c.onStop("all good\n<<PG_DONE>>");
    expect(calls).toEqual(["idle", "resume", "succeed"]);
  });

  it("hold turns the current turn manual, also during grace; clearing it does not succeed", () => {
    vi.useFakeTimers();
    const { c, calls } = make({ mode: "auto", graceSec: 5 });
    c.onStop("x");
    c.setHold(true);
    vi.advanceTimersByTime(10_000);
    c.setHold(false);
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual(["idle"]);
    c.setHold(true);
    c.onUserInput();
    c.onStop("again");
    expect(calls).toEqual(["idle", "resume", "idle"]);
    c.dispose();
    c.onUserInput();
    expect(calls).toHaveLength(3);
  });
});
