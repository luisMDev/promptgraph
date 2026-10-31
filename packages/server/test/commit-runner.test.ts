import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommitRunner } from "../src/runners/git/commit-runner.js";
import { checkpointIfDirty, checkpointMessage, squashMergeMessage, squashTarget } from "../src/runners/git/checkpoint.js";
import type { PredecessorOutput } from "../src/runners/types.js";
import { createTempRepo, fakeClaudeEnv, tempDir } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";


const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function repo() {
  const r = createTempRepo();
  cleanups.push(r.cleanup);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: r.repo, encoding: "utf8" }).trim();
  return { dir: r.repo, g, base: g("rev-parse", "HEAD") };
}

function runCommit(dir: string, base: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, predecessors: PredecessorOutput[] = []) {
  const locks: string[] = [];
  const lanes = {
    withLaneLock: async <T>(lane: { id: string }, fn: () => Promise<T>) => {
      locks.push(lane.id);
      return fn();
    },
  };
  const run = makeRun({ nodes: [{ id: "c", type: "commit", label: "Commit", config } as never] });
  const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(dir, base), predecessors });
  return { ctx, locks, exec: new CommitRunner({ lanes, env }).start(ctx) };
}

describe("checkpoint helpers", () => {
  it("checkpoints only a dirty worktree, including untracked files", async () => {
    const { dir, g } = repo();
    expect(await checkpointIfDirty(dir, "Plan")).toBeNull();
    fs.writeFileSync(path.join(dir, "new.txt"), "x");
    const sha = await checkpointIfDirty(dir, "Plan");
    expect(sha).toBe(g("rev-parse", "HEAD"));
    expect(g("log", "-1", "--format=%s")).toBe(checkpointMessage("Plan"));
    expect(g("status", "--porcelain")).toBe("");
  });

  it("squashTarget stops at the last real commit and never goes below the base", async () => {
    const { dir, g, base } = repo();
    expect(await squashTarget(dir, base)).toBeNull();
    fs.writeFileSync(path.join(dir, "a"), "1");
    await checkpointIfDirty(dir, "A");
    expect(await squashTarget(dir, base)).toBe(base);
    g("commit", "-q", "--allow-empty", "-m", "feat: real");
    const real = g("rev-parse", "HEAD");
    expect(await squashTarget(dir, base)).toBeNull();
    fs.writeFileSync(path.join(dir, "b"), "2");
    await checkpointIfDirty(dir, "B");
    fs.writeFileSync(path.join(dir, "c"), "3");
    await checkpointIfDirty(dir, "C");
    expect(await squashTarget(dir, base)).toBe(real);
  });

  it("squashTarget squashes lane merges that bring in only checkpoints, but not merged real commits", async () => {
    const { dir, g, base } = repo();
    const mergeSide = async (file: string, real: boolean) => {
      g("checkout", "-q", "-b", file, base);
      fs.writeFileSync(path.join(dir, file), file);
      if (real) {
        g("add", "-A");
        g("commit", "-q", "-m", `feat: ${file}`);
      } else await checkpointIfDirty(dir, file);
      g("checkout", "-q", "main");
      g("merge", "-q", "--no-ff", "-m", `Merge branch '${file}' into main`, file);
    };
    fs.writeFileSync(path.join(dir, "a"), "1");
    await checkpointIfDirty(dir, "A");
    await mergeSide("b", false);
    expect(await squashTarget(dir, base)).toBe(base);
    await mergeSide("c", true);
    expect(await squashTarget(dir, base)).toBeNull();
    fs.writeFileSync(path.join(dir, "d"), "4");
    await checkpointIfDirty(dir, "D");
    expect(await squashTarget(dir, base)).toBe(g("rev-parse", "HEAD~1"));
  });
});

describe("checkpoint helpers: edge cases", () => {
  it("a dirty submodule alone checkpoints nothing", async () => {
    const { dir, g } = repo();
    const sub = createTempRepo();
    cleanups.push(sub.cleanup);
    g("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.repo, "sub");
    g("commit", "-q", "-m", "add sub");
    fs.writeFileSync(path.join(dir, "sub", "untracked.txt"), "x");
    expect(g("status", "--porcelain")).toBe("M sub");
    expect(await checkpointIfDirty(dir, "Build")).toBeNull();
    expect(g("log", "-1", "--format=%s")).toBe("add sub");
  });

  it("refuses to checkpoint a worktree in the middle of a merge", async () => {
    const { dir, g } = repo();
    g("checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(dir, "README.md"), "theirs\n");
    g("commit", "-q", "-am", "side");
    g("checkout", "-q", "main");
    fs.writeFileSync(path.join(dir, "README.md"), "mine\n");
    g("commit", "-q", "-am", "main");
    expect(() => g("merge", "-q", "side")).toThrow();
    await expect(checkpointIfDirty(dir, "X")).rejects.toThrow(/middle of a merge/);
    expect(g("log", "-1", "--format=%s")).toBe("main");
  });

  it("squashTarget treats promptgraph squash merges of checkpoint-only lanes as noise", async () => {
    const { dir, g, base } = repo();
    const squashSide = async (file: string, real: boolean) => {
      g("checkout", "-q", "-b", file, base);
      fs.writeFileSync(path.join(dir, file), file);
      if (real) {
        g("add", "-A");
        g("commit", "-q", "-m", `feat: ${file}`);
      } else await checkpointIfDirty(dir, file);
      const tip = g("rev-parse", "HEAD");
      g("checkout", "-q", "main");
      g("merge", "-q", "--squash", file);
      g("commit", "-q", "-m", squashMergeMessage(`Merge branch '${file}' into main`, tip));
    };
    fs.writeFileSync(path.join(dir, "a"), "1");
    await checkpointIfDirty(dir, "A");
    await squashSide("b", false);
    expect(await squashTarget(dir, base)).toBe(base);
    await squashSide("c", true);
    expect(await squashTarget(dir, base)).toBeNull();
  });

  it("squashTarget never goes below a fork point", async () => {
    const { dir, g, base } = repo();
    fs.writeFileSync(path.join(dir, "a"), "1");
    const fork = (await checkpointIfDirty(dir, "A"))!;
    fs.writeFileSync(path.join(dir, "b"), "2");
    await checkpointIfDirty(dir, "B");
    expect(await squashTarget(dir, base)).toBe(base);
    expect(await squashTarget(dir, base, [fork])).toBe(fork);
    expect(await squashTarget(dir, base, [g("rev-parse", "HEAD")])).toBeNull();
  });
});

describe("CommitRunner", () => {
  it("refuses to commit a lane left in the middle of a merge", async () => {
    const { dir, g, base } = repo();
    g("checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(dir, "f.txt"), "B\n");
    g("add", "-A");
    g("commit", "-q", "-m", "side");
    g("checkout", "-q", "main");
    fs.writeFileSync(path.join(dir, "f.txt"), "C\n");
    g("add", "-A");
    g("commit", "-q", "-m", "main");
    try {
      g("merge", "side");
    } catch {
      // conflict expected
    }
    const head = g("rev-parse", "HEAD");
    const { exec } = runCommit(dir, base, { generateMessage: false, message: "after merge", squashCheckpoints: false });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("middle of a merge") });
    expect(g("rev-parse", "HEAD")).toBe(head);
  });

  it("nothing to commit → succeeded noop without a new commit", async () => {
    const { dir, g, base } = repo();
    const { exec, locks } = runCommit(dir, base, { generateMessage: false, message: "x" });
    expect(await exec.result).toEqual({ status: "succeeded", output: { noop: true } });
    expect(g("rev-parse", "HEAD")).toBe(base);
    expect(locks).toEqual(["main"]);
  });

  it("commits everything with a fixed message, squashing trailing checkpoints", async () => {
    const { dir, g, base } = repo();
    fs.writeFileSync(path.join(dir, "one.txt"), "1");
    await checkpointIfDirty(dir, "Step 1");
    fs.writeFileSync(path.join(dir, "two.txt"), "2");
    const { exec, ctx } = runCommit(dir, base, { generateMessage: false, message: "feat: add files\n\nBody" });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { message: "feat: add files\n\nBody" } });
    expect(result.status === "succeeded" && result.output.sha).toBe(g("rev-parse", "HEAD"));
    expect(g("log", "--format=%s", `${base}..HEAD`)).toBe("feat: add files");
    expect(g("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["one.txt", "two.txt"]);
    expect(ctx.events.map((e) => e.type)).toEqual(["commit:squashed_checkpoints"]);
  });

  it("keeps checkpoints when squashCheckpoints is false", async () => {
    const { dir, g, base } = repo();
    fs.writeFileSync(path.join(dir, "one.txt"), "1");
    await checkpointIfDirty(dir, "Step 1");
    fs.writeFileSync(path.join(dir, "two.txt"), "2");
    const { exec } = runCommit(dir, base, { generateMessage: false, message: "chore: two", squashCheckpoints: false });
    expect((await exec.result).status).toBe("succeeded");
    expect(g("log", "--format=%s", `${base}..HEAD`).split("\n")).toEqual(["chore: two", checkpointMessage("Step 1")]);
  });

  it("generates the message with headless claude from the diff stat and predecessor outputs", async () => {
    const { dir, g, base } = repo();
    const t = tempDir();
    cleanups.push(t.cleanup);
    const log = path.join(t.dir, "fake.log");
    const env = { ...process.env, ...fakeClaudeEnv(t.dir), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STRUCTURED: JSON.stringify({ title: "feat: add greeting", body: "Adds hello.txt." }) };
    fs.writeFileSync(path.join(dir, "hello.txt"), "hi");
    const preds: PredecessorOutput[] = [{ nodeId: "p", label: "Implement", type: "prompt", status: "succeeded", output: { text: "I added a greeting." }, error: null, sessionId: null, transcriptPath: null, laneId: "main" }];
    const { exec } = runCommit(dir, base, {}, env, preds);
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { message: "feat: add greeting\n\nAdds hello.txt.", usage: { inputTokens: 12, costUsd: 0.0123 } } });
    expect(g("log", "-1", "--format=%B")).toBe("feat: add greeting\n\nAdds hello.txt.");
    const inv = JSON.parse(fs.readFileSync(log, "utf8").trim()) as { argv: string[] };
    expect(inv.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--json-schema"]));
  });

  it("falls back to a deterministic message when headless claude fails", async () => {
    const { dir, g, base } = repo();
    const t = tempDir();
    cleanups.push(t.cleanup);
    const env = { ...process.env, ...fakeClaudeEnv(t.dir), FAKE_CLAUDE_MODE: "fail" };
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    const { exec } = runCommit(dir, base, { generateMessage: true }, env);
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { message: expect.stringMatching(/^chore: update 2 files\n\n/) } });
    expect(result.status === "succeeded" && result.output.usage).toBeUndefined();
    expect(g("log", "-1", "--format=%s")).toBe("chore: update 2 files");
  });

  it("reports git errors as failures", async () => {
    const { dir, base } = repo();
    fs.writeFileSync(path.join(dir, "x"), "1");
    fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho nope >&2\nexit 1\n", { mode: 0o755 });
    const { exec } = runCommit(dir, base, { generateMessage: false, message: "x" });
    const result = await exec.result;
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toMatch(/nope/);
  });
});
