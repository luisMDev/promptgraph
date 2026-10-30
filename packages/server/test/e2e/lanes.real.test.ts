import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, realClaudeEnv, tempDir } from "../helpers.js";
import { E2eServer, type E2eWorld } from "./harness.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const prompt = (file: string, content: string) => ({ prompt: `Create the file ${file} containing exactly the text ${content}. Do nothing else.` });

/** Opt-in: PG_REAL_CLAUDE=1. Uses a copy of the Claude config (never the real ~/.claude.json). */
describe.runIf(process.env.PG_REAL_CLAUDE === "1")("e2e: fan-out lanes, merge and commit (real claude, haiku)", () => {
  it("root → two parallel prompts → merge → commit with a generated message", { timeout: 600_000 }, async () => {
    const repo = createTempRepo("pg-real-repo-");
    const root = tempDir("pg-real-");
    cleanups.push(repo.cleanup, root.cleanup);
    const world: E2eWorld = { repo: repo.repo, root: root.dir, env: { ...process.env, ...realClaudeEnv(root.dir) }, claudeLog: "", cleanup: () => undefined };
    const s = await E2eServer.start(world);
    cleanups.push(() => s.close());

    await s.saveGraph({
      version: 1,
      id: "real-fan",
      name: "real-fan",
      settings: { defaults: { model: "haiku", completion: { mode: "auto", graceSec: 0 } }, keepWorktrees: "always" },
      nodes: [
        { id: "a", type: "prompt", label: "A", position: { x: 0, y: 100 }, config: prompt("a.txt", "A") },
        { id: "b", type: "prompt", label: "B", position: { x: 250, y: 0 }, config: prompt("b.txt", "B") },
        { id: "c", type: "prompt", label: "C", position: { x: 250, y: 200 }, config: prompt("c.txt", "C") },
        { id: "m", type: "merge", label: "Merge", position: { x: 500, y: 100 }, config: {} },
        { id: "commit", type: "commit", label: "Commit", position: { x: 750, y: 100 }, config: {} },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "a", target: "c" },
        { id: "e3", source: "b", target: "m" },
        { id: "e4", source: "c", target: "m" },
        { id: "e5", source: "m", target: "commit" },
      ],
    } as never);
    const runId = (await s.startRun("real-fan")).run.id;
    const done = await s.waitForRun(runId, ["succeeded", "failed", "paused"], 540_000);
    const summary = done.nodeRuns.map((n) => `${n.nodeId}:${n.status}:${n.laneId}:${n.error ?? ""}`);
    expect(done.run.status, summary.join(" ")).toBe("succeeded");

    const main = done.lanes.find((l) => l.id === "main")!;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo.repo, encoding: "utf8" }).trim();
    const files = git("ls-tree", "--name-only", main.branch).split("\n");
    expect(files).toEqual(expect.arrayContaining(["a.txt", "b.txt", "c.txt"]));
    for (const [file, content] of [["a.txt", "A"], ["b.txt", "B"], ["c.txt", "C"]] as const) {
      expect(git("show", `${main.branch}:${file}`)).toBe(content);
    }
    const message = git("log", "-1", "--format=%B", main.branch);
    expect(git("log", "--format=%s", `main..${main.branch}`).split("\n")).toHaveLength(1);
    expect(message).not.toMatch(/checkpoint/i);
    console.log(`[real fan-out] lanes=${done.lanes.map((l) => l.branch).join(", ")}\n${summary.join("\n")}\ncommit message:\n${message}`);
  });
});
