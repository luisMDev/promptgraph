import { afterEach, describe, expect, it } from "vitest";
import { generateMessage } from "../src/runners/git/messages.js";
import { createTempRepo, realClaudeEnv, tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

/** Opt-in: PG_REAL_CLAUDE=1. Uses a copy of the Claude config (never the real ~/.claude.json). */
describe.runIf(process.env.PG_REAL_CLAUDE === "1")("generateMessage pr (real claude)", () => {
  it("returns a structured PR title and body with usage", { timeout: 120_000 }, async () => {
    const t = tempDir();
    const repo = createTempRepo();
    cleanups.push(t.cleanup, repo.cleanup);
    const message = await generateMessage({
      cwd: repo.repo,
      kind: "pr",
      diffStat: " greeting.txt | 1 +\n 1 file changed, 1 insertion(+)",
      commits: ["feat: add greeting file"],
      outputs: [],
      model: "haiku",
      env: { ...process.env, ...realClaudeEnv(t.dir) },
    });
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.title).not.toBe("Changes from promptgraph");
    expect(message.body.length).toBeGreaterThan(0);
    expect(message.usage?.outputTokens).toBeGreaterThan(0);
  });
});
