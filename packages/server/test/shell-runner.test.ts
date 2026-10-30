import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths, ptyLogPath } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import { SHELL_TAIL_LINES, ShellRunner } from "../src/runners/shell-runner.js";
import { tempDir, waitFor } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(config: Record<string, unknown>) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const env = { PATH: process.env.PATH, HOME: t.dir, CLAUDECODE: "1", PG_HOME: path.join(t.dir, "pg") };
  const paths = getPaths(env);
  const ptys = new PtyManager(new EventBus(), () => null);
  cleanups.push(() => ptys.killAll());
  const runner = new ShellRunner({ ptys, paths, env });
  const run = makeRun({ nodes: [{ id: "sh", type: "shell", label: "Tests", config } as never] });
  const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(t.dir) });
  return { dir: t.dir, paths, ptys, run, ctx, exec: runner.start(ctx) };
}

describe("ShellRunner", () => {
  it("runs in the lane worktree with the node env and keeps the ANSI-stripped tail", async () => {
    const { dir, paths, run, ctx, exec } = setup({
      run: `pwd; printf '\\033[31mred\\033[0m\\n'; echo "v=$MY_VAR cc=\${CLAUDECODE:-unset}"; seq 1 300`,
      env: { MY_VAR: "42" },
    });
    const result = await exec.result;
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.exitCode).toBe(0);
    const lines = result.output.stdoutTail!.split("\n");
    expect(lines).toHaveLength(SHELL_TAIL_LINES);
    expect(lines.at(-1)).toBe("300");
    expect(lines[0]).toBe("101");
    expect(ctx.patches[0]).toEqual({ ptyId: ctx.nodeRun.id });
    const log = fs.readFileSync(ptyLogPath(paths, run.id, ctx.nodeRun.id), "utf8");
    expect(log).toContain(dir);
    expect(log).toContain("v=42 cc=unset");
    expect(log).toContain("\x1b[31mred");
  });

  it("fails on a non-zero exit code", async () => {
    const { exec } = setup({ run: "echo oops; exit 7" });
    expect(await exec.result).toEqual({ status: "failed", error: "Exited with code 7", output: { exitCode: 7, stdoutTail: "oops" } });
  });

  it("kills the command on timeout", async () => {
    const { exec } = setup({ run: "echo start; sleep 30", timeoutSec: 1 });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", error: "Timed out after 1s", output: { exitCode: null, timedOut: true, stdoutTail: "start" } });
  });

  it("cancel and fail stop a running command", async () => {
    const a = setup({ run: "sleep 30" });
    await a.exec.controls.cancel();
    expect(await a.exec.result).toEqual({ status: "cancelled" });

    const b = setup({ run: "echo waiting; sleep 30" });
    await waitFor(() => b.ptys.attach(b.ctx.nodeRun.id).replay.toString().includes("waiting"));
    b.exec.controls.fail("stop it");
    expect(await b.exec.result).toMatchObject({ status: "failed", error: "stop it", output: { stdoutTail: "waiting" } });
  });

  it("reads input typed into its terminal", async () => {
    const { ptys, ctx, exec } = setup({ run: "read answer; echo answer=$answer" });
    ptys.userInput(ctx.nodeRun.id, "yes\r");
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { stdoutTail: expect.stringContaining("answer=yes") } });
  });
});
