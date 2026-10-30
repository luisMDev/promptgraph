import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { HookRouter } from "../src/hooks/hook-router.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import { installPgHook } from "../src/runners/claude/pg-hook.js";
import { createTempRepo, realClaudeEnv, tempDir, waitFor } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const repo = createTempRepo();
  cleanups.push(repo.cleanup);
  const env = { ...process.env, ...realClaudeEnv(t.dir) };
  const paths = getPaths(env);
  const ptys = new PtyManager(new EventBus(), () => null);
  cleanups.push(() => ptys.killAll());
  const hooks = new HookRouter();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const [, , id, event] = (req.url ?? "").split("/");
      hooks.dispatch(id!, event!, JSON.parse(body || "{}"));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const runner = new ClaudeRunner({ ptys, hooks, paths, pgHookPath: installPgHook(paths), endpoint: () => ({ port, token: "t" }), env });
  return { runner, repo: repo.repo, dir: t.dir };
}

/** Opt-in: PG_REAL_CLAUDE=1. Uses a copy of the Claude config (never the real ~/.claude.json). */
describe.runIf(process.env.PG_REAL_CLAUDE === "1")("ClaudeRunner (real claude)", () => {
  it("runs a tiny prompt to success via hooks and /exit", { timeout: 180_000 }, async () => {
    const { runner, repo } = await setup();
    const run = makeRun({ nodes: [{ id: "n", type: "prompt", label: "Ping", config: { prompt: "Reply with exactly PONG", model: "haiku", completion: { mode: "auto", graceSec: 0 } } } as never] });
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(repo) });
    const result = await runner.start(ctx).result;
    expect(result).toMatchObject({ status: "succeeded", output: { text: expect.stringContaining("PONG") } });
    if (result.status !== "succeeded") return;
    expect(result.output.usage!.outputTokens).toBeGreaterThan(0);
    expect(result.output.usage!.costUsd).toBeGreaterThan(0);
    expect(ctx.current.transcriptPath).toBeTruthy();
  });

  it("cancelling while a permission dialog is open does not approve the tool call", { timeout: 180_000 }, async () => {
    const { runner, repo, dir } = await setup();
    const marker = path.join(dir, "PWNED");
    const run = makeRun({
      nodes: [
        {
          id: "n",
          type: "prompt",
          label: "Touch",
          config: { prompt: `Run this exact shell command with the Bash tool: touch ${marker}`, model: "haiku", permissionMode: "manual" },
        } as never,
      ],
    });
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(repo) });
    const exec = runner.start(ctx);
    await waitFor(() => ctx.current?.status === "waiting_input" && ctx.current.waitingReason?.notificationType === "permission_prompt", 120_000);
    expect(fs.existsSync(marker)).toBe(false);
    await exec.controls.cancel();
    expect(await exec.result).toMatchObject({ status: "cancelled" });
    await new Promise((r) => setTimeout(r, 1000));
    expect(fs.existsSync(marker)).toBe(false);
  });
});
