import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphInput } from "@promptgraph/shared";
import { createTempRepo, realClaudeEnv, tempDir } from "../helpers.js";
import { E2eServer, type E2eWorld } from "./harness.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Opt-in: PG_REAL_CLAUDE=1. Uses a copy of the Claude config (never the real ~/.claude.json). */
describe.runIf(process.env.PG_REAL_CLAUDE === "1")("e2e: test-fix loop (real claude, haiku)", () => {
  it("test -f ok.txt fails, a real Claude fix creates it, the loop passes on its second pass and commits", { timeout: 600_000 }, async () => {
    const repo = createTempRepo("pg-real-repo-");
    const root = tempDir("pg-real-");
    cleanups.push(repo.cleanup, root.cleanup);
    const world: E2eWorld = { repo: repo.repo, root: root.dir, env: { ...process.env, ...realClaudeEnv(root.dir) }, claudeLog: "", cleanup: () => undefined };
    const s = await E2eServer.start(world);
    cleanups.push(() => s.close());

    const node = (id: string, type: string, x: number, y: number, config: object) => ({ id, type, label: id, position: { x, y }, config });
    await s.saveGraph({
      version: 1,
      id: "real-loop",
      name: "real-loop",
      settings: { defaults: { model: "haiku", completion: { mode: "auto", graceSec: 0 } } },
      nodes: [
        node("test", "shell", 0, 0, { run: "test -f ok.txt" }),
        node("check", "condition", 250, 0, { evaluator: { kind: "exitCode", equals: 0 } }),
        node("commit", "commit", 500, 0, { generateMessage: false, message: "test: add ok.txt" }),
        node("fix", "prompt", 500, 150, { prompt: "Create an empty file named ok.txt" }),
      ],
      edges: [
        { id: "e1", source: "test", target: "check", when: "always" },
        { id: "e2", source: "check", sourcePort: "true", target: "commit" },
        { id: "e3", source: "check", sourcePort: "false", target: "fix" },
        { id: "loop", source: "fix", target: "test", loop: { maxIterations: 3, onExhausted: "fail" } },
      ],
    } as GraphInput);

    const runId = (await s.startRun("real-loop")).run.id;
    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 540_000);
    const summary = done.nodeRuns.map((n) => `${n.nodeId}#${n.iteration}.${n.attempt}:${n.status}:${n.error ?? ""}`);
    console.log(`[real loop]\n${summary.join("\n")}\nloops: ${JSON.stringify(done.loops)}\nfix: ${done.nodeRuns.find((n) => n.nodeId === "fix")!.output?.text}`);
    expect(done.run.status, summary.join(" ")).toBe("succeeded");
    const runs = (id: string) => done.nodeRuns.filter((n) => n.nodeId === id).map((n) => [n.iteration, n.status]);
    // Second pass (iteration 1, 0-based) passes: one real fix, one loop-back.
    expect(runs("test")).toEqual([[0, "failed"], [1, "succeeded"]]);
    expect(runs("fix")).toEqual([[0, "succeeded"], [1, "skipped"]]);
    expect(runs("commit")).toEqual([[0, "succeeded"]]);
    expect(done.loops).toEqual([{ edgeId: "loop", iteration: 1, maxIterations: 3, exhausted: false }]);
    const sha = done.nodeRuns.find((n) => n.nodeId === "commit")!.output!.sha!;
    expect(execFileSync("git", ["show", "--name-only", "--format=", sha], { cwd: repo.repo, encoding: "utf8" }).trim()).toBe("ok.txt");
  });
});
