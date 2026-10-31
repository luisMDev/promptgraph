import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Lane } from "@promptgraph/shared";
import { buildMessagePrompt } from "../src/runners/git/messages.js";
import { PrRunner } from "../src/runners/git/pr-runner.js";
import type { PredecessorOutput } from "../src/runners/types.js";
import { createTempRepo, FAKE_GH, fakeClaudeEnv, tempDir, waitFor } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const BRANCH = "pg/g1/abcd/main";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

interface GhCall {
  argv: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
}

function setup(opts: { origin?: boolean; env?: Record<string, string> } = {}) {
  const r = createTempRepo();
  const t = tempDir();
  cleanups.push(r.cleanup, t.cleanup);
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const base = g(r.repo, "rev-parse", "HEAD");
  const origin = path.join(t.dir, "origin.git");
  if (opts.origin !== false) {
    g(t.dir, "init", "-q", "--bare", origin);
    g(r.repo, "remote", "add", "origin", origin);
  }
  g(r.repo, "checkout", "-q", "-b", BRANCH);
  fs.writeFileSync(path.join(r.repo, "feature.txt"), "feature\n");
  g(r.repo, "add", "-A");
  g(r.repo, "commit", "-qm", "feat: add feature");
  const ghLog = path.join(t.dir, "gh.log");
  const claudeLog = path.join(t.dir, "claude.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...fakeClaudeEnv(t.dir, { FAKE_CLAUDE_LOG: claudeLog }),
    PG_GH_BIN: FAKE_GH,
    FAKE_GH_LOG: ghLog,
    ...opts.env,
  };
  const pushed: string[] = [];
  const lanes = {
    withLaneLock: <T>(_lane: Pick<Lane, "runId" | "id">, fn: () => Promise<T>) => fn(),
    markPushed: (lane: Lane) => void pushed.push(lane.id),
  };
  const readLines = <T>(file: string): T[] =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as T) : [];
  return {
    dir: r.repo,
    origin,
    base,
    env,
    pushed,
    lanes,
    g,
    ghCalls: () => readLines<GhCall>(ghLog),
    claudeCalls: () => readLines<{ argv: string[] }>(claudeLog),
  };
}

type Setup = ReturnType<typeof setup>;

function start(s: Setup, config: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, predecessors: PredecessorOutput[] = []) {
  const run = makeRun({ settings: settings as never, nodes: [{ id: "pr", type: "pr", label: "Open PR", config } as never] });
  const lane = { ...makeLane(s.dir, s.base), branch: BRANCH };
  const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane, predecessors, laneOutputs: [] });
  const exec = new PrRunner({ lanes: s.lanes, env: s.env }).start(ctx);
  return { ctx, exec };
}

const head = (s: Setup) => s.g(s.dir, "rev-parse", "HEAD");

const commitPred: PredecessorOutput = {
  nodeId: "c",
  label: "Commit",
  type: "commit",
  status: "succeeded",
  output: { sha: "abc", message: "feat: add feature" },
  error: null,
  sessionId: null,
  transcriptPath: null,
  laneId: "main",
};

describe("PrRunner", () => {
  it("generates title/body, waits for approval, pushes and creates a draft PR with the edited title", async () => {
    const s = setup();
    const { ctx, exec } = start(s, {}, {}, [commitPred]);
    await waitFor(() => ctx.current.status === "waiting_approval");
    // The approval dialog reads the proposal from the output.
    expect(ctx.current.output).toMatchObject({ title: "fake title", body: "fake body" });
    expect(ctx.current.output?.usage?.costUsd).toBeGreaterThanOrEqual(0);
    expect(s.claudeCalls()[0]!.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--json-schema"]));
    expect(s.ghCalls()).toEqual([]);

    exec.controls.approve!({ approved: true, title: "Edited title", body: "Edited body", comment: "ok", headSha: head(s) });
    const result = await exec.result;
    expect(result).toMatchObject({
      status: "succeeded",
      output: { prUrl: "https://github.com/fake/repo/pull/1", title: "Edited title", body: "Edited body", approved: true, comment: "ok" },
    });
    expect(ctx.current.status).toBe("running");
    expect(s.g(s.origin, "rev-parse", BRANCH)).toBe(s.g(s.dir, "rev-parse", "HEAD"));
    expect(s.pushed).toEqual(["main"]);
    const [call] = s.ghCalls();
    expect(call!.argv).toEqual(["pr", "create", "--base", "main", "--head", BRANCH, "--title", "Edited title", "--body-file", "-", "--draft"]);
    expect(call!.stdin).toBe("Edited body");
    expect(call!.cwd).toBe(s.dir);
    expect(call!.env.GH_PROMPT_DISABLED).toBe("1");
  });

  it("uses a fixed title/body and skips the gate only when the graph allows it", async () => {
    const s = setup();
    const { ctx, exec } = start(s, { title: "Fixed", body: "Body text", draft: false, base: "main", requireApproval: false }, { allowPrWithoutApproval: true });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "succeeded", output: { title: "Fixed", body: "Body text", prUrl: expect.any(String) } });
    expect(ctx.patches.some((p) => p.status === "waiting_approval")).toBe(false);
    expect(s.claudeCalls()).toEqual([]);
    expect(s.ghCalls()[0]!.argv).not.toContain("--draft");
  });

  it("requireApproval false without allowPrWithoutApproval still waits", async () => {
    const s = setup();
    const { ctx, exec } = start(s, { title: "Fixed", body: "", requireApproval: false });
    await waitFor(() => ctx.current.status === "waiting_approval");
    await exec.controls.cancel();
    expect(await exec.result).toEqual({ status: "cancelled" });
    expect(s.ghCalls()).toEqual([]);
  });

  it("rejection fails without pushing", async () => {
    const s = setup();
    const { ctx, exec } = start(s, { title: "T", body: "B" });
    await waitFor(() => ctx.current.status === "waiting_approval");
    exec.controls.approve!({ approved: false, comment: "not yet" });
    expect(await exec.result).toMatchObject({ status: "failed", error: "Pull request rejected: not yet", output: { approved: false, title: "T" } });
    expect(s.g(s.origin, "branch", "--list")).toBe("");
    expect(s.pushed).toEqual([]);
  });

  it("gh failure fails with its stderr after the push (branch kept as pushed)", async () => {
    const s = setup({ env: { FAKE_GH_FAIL: "GraphQL: Resource not accessible" } });
    const { exec } = start(s, { title: "T", body: "B" });
    exec.controls.approve!({ approved: true, headSha: head(s) });
    const result = await exec.result;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("GraphQL: Resource not accessible");
    expect(result.output).toMatchObject({ title: "T", body: "B" });
    expect(s.pushed).toEqual(["main"]);
  });

  it("an existing PR for the branch counts as created", async () => {
    const s = setup({ env: { FAKE_GH_EXISTS: "1", FAKE_GH_URL: "https://github.com/fake/repo/pull/7" } });
    const { exec } = start(s, { title: "T", body: "B" });
    exec.controls.approve!({ approved: true, headSha: head(s) });
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { prUrl: "https://github.com/fake/repo/pull/7" } });
  });

  it("push failure fails with git's stderr and never calls gh", async () => {
    const s = setup({ origin: false });
    const { exec } = start(s, { title: "T", body: "B" });
    exec.controls.approve!({ approved: true, headSha: head(s) });
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("git push failed") });
    expect(s.ghCalls()).toEqual([]);
    expect(s.pushed).toEqual([]);
  });

  it("pushes from a lane worktree to a relative origin URL resolved against the main checkout", async () => {
    const s = setup();
    s.g(s.dir, "remote", "set-url", "origin", path.relative(s.dir, s.origin));
    const wt = path.join(path.dirname(s.origin), "wt");
    s.g(s.dir, "worktree", "add", "-q", "-b", "lane-branch", wt);
    const run = makeRun({ nodes: [{ id: "pr", type: "pr", label: "Open PR", config: { title: "T", body: "B" } } as never] }, s.dir);
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: { ...makeLane(wt, s.base), branch: "lane-branch" } });
    const exec = new PrRunner({ lanes: s.lanes, env: s.env }).start(ctx);
    exec.controls.approve!({ approved: true, headSha: s.g(wt, "rev-parse", "HEAD") });
    expect(await exec.result).toMatchObject({ status: "succeeded" });
    expect(s.g(s.origin, "rev-parse", "lane-branch")).toBe(s.g(wt, "rev-parse", "HEAD"));
    expect(s.g(s.dir, "config", "--get", "remote.origin.url")).toMatch(/^\.\.\//);
  });

  it("pushes exactly the approved commit, not what the lane holds by then", async () => {
    const s = setup();
    const { ctx, exec } = start(s, { title: "T", body: "B" });
    await waitFor(() => ctx.current.status === "waiting_approval");
    const reviewed = head(s);
    s.g(s.dir, "commit", "-q", "--allow-empty", "-m", "unreviewed");
    exec.controls.approve!({ approved: true, headSha: reviewed });
    expect(await exec.result).toMatchObject({ status: "succeeded" });
    expect(s.g(s.origin, "rev-parse", BRANCH)).toBe(reviewed);
  });

  it("an approval that does not name the reviewed commit fails without pushing", async () => {
    const s = setup();
    const { exec } = start(s, { title: "T", body: "B" });
    exec.controls.approve!({ approved: true });
    expect(await exec.result).toMatchObject({ status: "failed", error: expect.stringContaining("reviewed commit") });
    expect(s.g(s.origin, "branch", "--list")).toBe("");
  });

  it("fail() while waiting fails with the reason", async () => {
    const s = setup();
    const { ctx, exec } = start(s, { title: "T", body: "B" });
    await waitFor(() => ctx.current.status === "waiting_approval");
    exec.controls.fail("changed my mind");
    expect(await exec.result).toMatchObject({ status: "failed", error: "changed my mind", output: { title: "T" } });
  });
});

describe("buildMessagePrompt (pr)", () => {
  it("includes the diff stat, commit subjects and step outputs", () => {
    const prompt = buildMessagePrompt({
      cwd: "/x",
      kind: "pr",
      diffStat: " feature.txt | 1 +",
      commits: ["feat: add feature"],
      outputs: [commitPred],
    });
    expect(prompt).toContain("pull request");
    expect(prompt).toContain("feature.txt | 1 +");
    expect(prompt).toContain("Commits:\n- feat: add feature");
    expect(prompt).toContain("### Commit (commit)");
  });
});
