import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pty from "node-pty";
import { HeadlessResultSchema, StopPayloadSchema } from "@promptgraph/shared";
import { FAKE_CLAUDE, fakeClaudeEnv, tempDir, waitFor } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const env = { ...process.env, ...fakeClaudeEnv(t.dir) } as Record<string, string>;
  const work = path.join(t.dir, "work");
  fs.mkdirSync(work);
  // Hook command that appends "<event> <payload>" lines to a file.
  const log = path.join(t.dir, "hooks.log");
  const hook = path.join(t.dir, "hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\n{ printf '%s ' "$1"; cat; echo; } >> '${log}'\n`, { mode: 0o755 });
  const hooks = Object.fromEntries(
    [
      ["SessionStart", "session-start"],
      ["PreToolUse", "activity"],
      ["Notification", "notification"],
      ["Stop", "stop"],
    ].map(([k, v]) => [k, [{ hooks: [{ type: "command", command: `${hook} ${v}` }] }]]),
  );
  const settings = path.join(t.dir, "hooks.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks }));
  // Only complete lines: a hook may still be writing the last one.
  const events = () => {
    if (!fs.existsSync(log)) return [];
    const text = fs.readFileSync(log, "utf8");
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(" ");
        return { event: l.slice(0, i), payload: JSON.parse(l.slice(i + 1)) as Record<string, unknown> };
      });
  };
  return { env, work, settings, events };
}

describe("fake-claude fixture", () => {
  it("runs an interactive turn with hooks, transcript usage and /exit", async () => {
    const { env, work, settings, events } = setup();
    const sid = "2b0e3c3e-0000-4000-8000-000000000001";
    const p = pty.spawn(FAKE_CLAUDE, ["build it [[write:out.txt:hello]] [[ask]] [[marker:DONE]]", "--session-id", sid, "--settings", settings], {
      cwd: work,
      env,
      cols: 100,
      rows: 30,
    });
    let output = "";
    p.onData((d) => (output += d));
    const exited = new Promise<number>((r) => p.onExit((e) => r(e.exitCode)));

    await waitFor(() => events().some((e) => e.event === "notification"));
    p.write("yes\r");
    const stop = await waitFor(() => events().find((e) => e.event === "stop"));
    p.write("/exit\r");
    expect(await exited).toBe(0);

    expect(events().map((e) => e.event)).toEqual(["session-start", "activity", "notification", "stop"]);
    const payload = StopPayloadSchema.parse(stop.payload);
    expect(payload.session_id).toBe(sid);
    expect(payload.last_assistant_message).toMatch(/answer: yes\)\nDONE$/);
    expect(fs.readFileSync(path.join(work, "out.txt"), "utf8")).toBe("hello");
    const lines = fs.readFileSync(payload.transcript_path!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.find((l) => l.type === "assistant").message.usage.output_tokens).toBeGreaterThan(0);
    expect(output).toContain("Fake Claude Code");
  });

  it("exits 1 on [[fail]]", async () => {
    const { env, work, settings } = setup();
    const p = pty.spawn(FAKE_CLAUDE, ["x [[fail]]", "--settings", settings], { cwd: work, env });
    expect(await new Promise((r) => p.onExit((e) => r(e.exitCode)))).toBe(1);
  });

  it("prints a headless JSON envelope with structured_output", () => {
    const { env, work } = setup();
    const schema = JSON.stringify({ type: "object", properties: { title: { type: "string" }, pass: { type: "boolean" } } });
    const out = execFileSync(FAKE_CLAUDE, ["-p", "--output-format", "json", "--json-schema", schema], {
      cwd: work,
      env,
      input: "summarise [[judge:false]]",
    }).toString();
    const result = HeadlessResultSchema.parse(JSON.parse(out));
    expect(result.is_error).toBe(false);
    expect(result.structured_output).toEqual({ title: "fake title", pass: false });
  });
});
