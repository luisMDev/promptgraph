import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { parseCliArgs } from "../src/cli/args.js";
import { checkPrereqs } from "../src/cli/prereqs.js";
import { startServer } from "../src/cli/server.js";
import { LaneManager } from "../src/workspace/lane-manager.js";
import { createTempRepo, FAKE_CLAUDE, FAKE_GH, fakeClaudeEnv, tempDir } from "./helpers.js";

describe("parseCliArgs", () => {
  it("applies defaults", () => {
    expect(parseCliArgs([], "/work")).toEqual({ repoDir: "/work", port: 4777, open: true, help: false, version: false });
  });

  it("parses repo dir, port and flags", () => {
    expect(parseCliArgs(["../repo", "--port", "5000", "--no-open"], "/work/x")).toMatchObject({ repoDir: "/work/repo", port: 5000, open: false });
    expect(parseCliArgs(["--port=0", "-h", "--version"], "/w")).toMatchObject({ port: 0, help: true, version: true });
  });

  it("rejects bad input", () => {
    expect(() => parseCliArgs(["--port"], "/w")).toThrow("Invalid port");
    expect(() => parseCliArgs(["--port", "99999"], "/w")).toThrow("Invalid port");
    expect(() => parseCliArgs(["--bogus"], "/w")).toThrow("Unknown option");
    expect(() => parseCliArgs(["a", "b"], "/w")).toThrow("Unexpected argument");
  });
});

describe("checkPrereqs", () => {
  it("passes with git and the configured claude", async () => {
    const report = await checkPrereqs({ ...process.env, PG_CLAUDE_BIN: FAKE_CLAUDE });
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.includes("Claude Code"))).toBe(false);
  });

  it("warns when claude is missing and fails without git", async () => {
    const report = await checkPrereqs({ PATH: "/nonexistent", PG_CLAUDE_BIN: "/nonexistent/claude" });
    expect(report.errors).toEqual(["git not found: promptgraph needs git on PATH"]);
    expect(report.warnings).toContainEqual(expect.stringContaining("Claude Code (/nonexistent/claude) not found"));
    expect(report.warnings).toContain("GitHub CLI (gh) not found: PR nodes will fail");
  });

  it("checks the gh binary set by PG_GH_BIN", async () => {
    const env = { ...process.env, PG_CLAUDE_BIN: FAKE_CLAUDE };
    expect((await checkPrereqs({ ...env, PG_GH_BIN: FAKE_GH })).warnings.some((w) => w.includes("GitHub CLI"))).toBe(false);
    expect((await checkPrereqs({ ...env, PG_GH_BIN: "/nonexistent/gh" })).warnings).toContain("GitHub CLI (/nonexistent/gh) not found: PR nodes will fail");
  });
});

describe("startServer", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });

  it("serves the API and WS on 127.0.0.1 with the session token, then closes", async () => {
    const prune = vi.spyOn(LaneManager.prototype, "prune");
    const { repo, cleanup } = createTempRepo();
    const t = tempDir();
    cleanups.push(cleanup, t.cleanup);
    const env = { ...process.env, ...fakeClaudeEnv(t.dir) };

    const server = await startServer({ repoPath: repo, port: 0, env, warnings: ["w1"] });
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await server.close();
    });

    expect(prune).toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, ".promptgraph", "graphs"))).toBe(true);
    expect(fs.existsSync(path.join(server.ctx.paths.binDir, "pg-hook"))).toBe(true);
    expect(server.ctx.paths.home).toBe(env.PG_HOME);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?t=${server.token}`);
    expect(server.ctx.port).toBe(server.port);

    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/graphs`)).status).toBe(401);
    const res = await fetch(`${base}/api/graphs`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(await res.json()).toEqual({ graphs: [] });

    const opened = await fetch(server.url, { redirect: "manual" });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("set-cookie")).toContain(server.token);

    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${server.token}`);
      ws.once("message", (raw) => {
        ws.close();
        resolve(String(raw));
      });
      ws.once("error", reject);
    });
    expect(JSON.parse(hello)).toMatchObject({ type: "hello" });

    await server.close();
    closed = true;
    await expect(fetch(`${base}/api/graphs`)).rejects.toThrow();
  });

  it("reports a busy port", async () => {
    const { repo, cleanup } = createTempRepo();
    const t = tempDir();
    cleanups.push(cleanup, t.cleanup);
    const env = { ...process.env, ...fakeClaudeEnv(t.dir) };
    const first = await startServer({ repoPath: repo, port: 0, env });
    cleanups.push(() => first.close());
    await expect(startServer({ repoPath: repo, port: first.port, env })).rejects.toThrow(`Port ${first.port} is already in use`);
  });
});
