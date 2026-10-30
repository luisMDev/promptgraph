import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConditionRunner } from "../src/runners/condition-runner.js";
import { createTempRepo, realClaudeEnv, tempDir } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

/** Opt-in: PG_REAL_CLAUDE=1. Uses a copy of the Claude config (never the real ~/.claude.json). */
describe.runIf(process.env.PG_REAL_CLAUDE === "1")("ConditionRunner judge (real claude)", () => {
  it("answers a trivially answerable question with a structured verdict", { timeout: 120_000 }, async () => {
    const t = tempDir();
    const repo = createTempRepo();
    cleanups.push(t.cleanup, repo.cleanup);
    fs.writeFileSync(path.join(repo.repo, "README.md"), "# test repo\nhello\n");
    const run = makeRun(
      {
        settings: { baseBranch: "main", defaults: { model: "haiku" } } as never,
        nodes: [{ id: "c", type: "condition", label: "Check", config: { evaluator: { kind: "judge", question: "Does the test output report that all tests passed?" } } } as never],
      },
      repo.repo,
    );
    const judge = (text: string) => {
      const ctx = makeCtx({
        run,
        node: run.graphSnapshot.nodes[0]!,
        lane: makeLane(repo.repo),
        predecessors: [
          { nodeId: "t", label: "Tests", type: "shell", status: "succeeded", output: { exitCode: 0, stdoutTail: text }, error: null, sessionId: null, transcriptPath: null, laneId: "main" },
        ],
      });
      return new ConditionRunner({ env: { ...process.env, ...realClaudeEnv(t.dir) } }).start(ctx).result;
    };
    const pass = await judge("Test Files  3 passed (3)\nTests  12 passed (12)");
    expect(pass).toMatchObject({ status: "succeeded", output: { result: true, port: "true" } });
    if (pass.status === "succeeded") {
      expect(pass.output.text?.length).toBeGreaterThan(0);
      expect(pass.output.usage?.outputTokens).toBeGreaterThan(0);
    }
    const fail = await judge("Test Files  1 failed (3)\nTests  2 failed | 10 passed (12)");
    expect(fail).toMatchObject({ status: "succeeded", output: { result: false, port: "false" } });
  });
});
