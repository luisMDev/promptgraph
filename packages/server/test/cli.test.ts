import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonInfoSchema, EXIT_DAEMON_LOCKED } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { parseCliArgs } from "../src/cli/args.js";
import { checkPrereqs } from "../src/cli/prereqs.js";
import { daemonInfoPath, portFilePath, readDaemonInfo } from "../src/config/daemon-info.js";
import { getPaths } from "../src/config/paths.js";
import { tokenPath } from "../src/config/token.js";
import { portCandidates, startDaemon } from "../src/daemon/start.js";
import { sessionCookieValue } from "../src/hooks/hook-token.js";
import { LaneManager } from "../src/workspace/lane-manager.js";
import { processStartTime } from "../src/util/process.js";
import { createTempRepo, FAKE_CLAUDE, FAKE_GH, fakeClaudeEnv, tempDir } from "./helpers.js";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

describe("parseCliArgs", () => {
  it("applies defaults", () => {
    expect(parseCliArgs([], "/work")).toEqual({ command: "open-repo", repoDir: "/work", port: null, open: true, foreground: false, help: false, version: false });
  });

  it("parses repo dir, port and flags", () => {
    expect(parseCliArgs(["../repo", "--port", "5000", "--no-open", "--foreground"], "/work/x")).toMatchObject({ repoDir: "/work/repo", port: 5000, open: false, foreground: true });
    expect(parseCliArgs(["--port=0", "-h", "--version"], "/w")).toMatchObject({ port: 0, help: true, version: true });
    expect(parseCliArgs(["mcp", "--help"], "/w")).toMatchObject({ command: "mcp", help: true });
    expect(parseCliArgs(["./mcp"], "/w")).toMatchObject({ command: "open-repo", repoDir: "/w/mcp" });
    expect(parseCliArgs(["daemon", "--port", "4800"], "/w")).toMatchObject({ command: "daemon", port: 4800 });
    expect(parseCliArgs(["./daemon"], "/w")).toMatchObject({ command: "open-repo", repoDir: "/w/daemon" });
    expect(parseCliArgs(["constructor"], "/w")).toMatchObject({ command: "open-repo", repoDir: "/w/constructor" });
  });

  it("rejects bad input", () => {
    expect(() => parseCliArgs(["--port"], "/w")).toThrow("Invalid port");
    expect(() => parseCliArgs(["--port", "99999"], "/w")).toThrow("Invalid port");
    expect(() => parseCliArgs(["--bogus"], "/w")).toThrow("Unknown option");
    expect(() => parseCliArgs(["a", "b"], "/w")).toThrow("Unexpected argument");
    expect(() => parseCliArgs(["mcp", "x"], "/w")).toThrow("Unexpected argument");
    expect(() => parseCliArgs(["daemon", "x"], "/w")).toThrow("Unexpected argument");
    expect(() => parseCliArgs(["daemon", "--foreground"], "/w")).toThrow("Unknown option");
    expect(() => parseCliArgs(["x", "daemon"], "/w")).toThrow("Unexpected argument");
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
    expect(report.warnings).toContainEqual(expect.stringContaining("curl not found"));
  });

  it("checks the gh binary set by PG_GH_BIN", async () => {
    const env = { ...process.env, PG_CLAUDE_BIN: FAKE_CLAUDE };
    expect((await checkPrereqs({ ...env, PG_GH_BIN: FAKE_GH })).warnings.some((w) => w.includes("GitHub CLI"))).toBe(false);
    expect((await checkPrereqs({ ...env, PG_GH_BIN: "/nonexistent/gh" })).warnings).toContain("GitHub CLI (/nonexistent/gh) not found: PR nodes will fail");
  });
});

describe("startDaemon", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });

  function env(): NodeJS.ProcessEnv {
    const t = tempDir();
    cleanups.push(t.cleanup);
    return { ...process.env, ...fakeClaudeEnv(t.dir) };
  }

  it("serves the API and WS on 127.0.0.1 with the persistent token, writes its record and port, then closes", async () => {
    const prune = vi.spyOn(LaneManager.prototype, "prune");
    const { repo, cleanup } = createTempRepo();
    cleanups.push(cleanup);
    const e = env();
    const daemon = await startDaemon({ port: 0, env: e, warnings: ["w1"] });
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await daemon.close();
    });
    const { paths } = daemon.ctx;
    expect(paths.home).toBe(e.PG_HOME);
    expect(fs.existsSync(path.join(paths.binDir, "pg-hook"))).toBe(true);
    expect(daemon.origin).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(daemon.ctx.port).toBe(daemon.port);
    const token = fs.readFileSync(tokenPath(paths), "utf8").trim();
    expect(token).toBe(daemon.ctx.getToken());
    expect(fs.statSync(tokenPath(paths)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.stateDb).mode & 0o777).toBe(0o600);
    const info = DaemonInfoSchema.parse(JSON.parse(fs.readFileSync(daemonInfoPath(paths), "utf8")));
    expect(info).toMatchObject({ version: 2, pid: process.pid, pidStart: processStartTime(process.pid), port: daemon.port });
    expect(readDaemonInfo(paths)).toEqual(info);
    expect(fs.readFileSync(portFilePath(paths), "utf8").trim()).toBe(String(daemon.port));

    // Registration activates: graphs dir and worktree prune; nothing happens to a repository before.
    expect(prune).not.toHaveBeenCalled();
    const base = daemon.origin;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await fetch(`${base}/api/repos`)).status).toBe(401);
    const added = (await (await fetch(`${base}/api/repos`, { method: "POST", headers: auth, body: JSON.stringify({ path: repo }) })).json()) as { id: string };
    expect(prune).toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, ".promptgraph", "graphs"))).toBe(true);
    const res = await fetch(`${base}/api/repos/${added.id}/graphs`, { headers: auth });
    expect(await res.json()).toEqual({ graphs: [] });

    const opened = await fetch(`${base}/r/${added.id}?t=${token}`, { redirect: "manual" });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(`/r/${added.id}`);
    expect(opened.headers.get("set-cookie")).toContain(`pg_token=${sessionCookieValue(token)}`);

    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { headers: { authorization: `Bearer ${token}` } });
      ws.once("message", (raw) => {
        ws.close();
        resolve(String(raw));
      });
      ws.once("error", reject);
    });
    expect(JSON.parse(hello)).toMatchObject({ type: "hello" });

    await daemon.close();
    closed = true;
    await expect(fetch(`${base}/api/repos`)).rejects.toThrow();
    expect(fs.existsSync(daemonInfoPath(paths))).toBe(false);
    // The token stays: windows and clients keep working after a restart.
    const again = await startDaemon({ port: 0, env: e });
    expect(again.ctx.getToken()).toBe(token);
    await again.close();
  });

  it("`promptgraph daemon` exits with EXIT_DAEMON_LOCKED while another daemon holds the lock", { timeout: 30_000 }, async () => {
    const e = { ...env(), PG_DAEMON_SHELL_ENV: "0" };
    const running = await startDaemon({ port: 0, env: e });
    cleanups.push(() => running.close());
    const child = spawn(process.execPath, ["--conditions=source", "--import", TSX, path.join(SERVER_SRC, "src/cli/index.ts"), "daemon", "--port", "0"], {
      cwd: SERVER_SRC,
      env: e,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(code).toBe(EXIT_DAEMON_LOCKED);
    expect(stderr).toContain(`promptgraph daemon is already running (pid ${process.pid})`);
    // The running daemon is untouched.
    expect(readDaemonInfo(getPaths(e))).toMatchObject({ pid: process.pid, port: running.port });
  });

  it("an explicit busy port fails with EADDRINUSE and releases the lock", async () => {
    const e = env();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const busy = (blocker.address() as net.AddressInfo).port;
    await expect(startDaemon({ port: busy, env: e })).rejects.toMatchObject({ code: "EADDRINUSE", message: `Port ${busy} is already in use` });
    const ok = await startDaemon({ port: 0, env: e });
    await ok.close();
  });

  it("without an explicit port tries the sticky port, then PG_PORT_DEFAULT, then a random one", async () => {
    expect(portCandidates(5001, { PG_PORT_DEFAULT: "5002" })).toEqual([5001, 5002, 0]);
    expect(portCandidates(null, {})).toEqual([4777, 0]);
    expect(portCandidates(null, { PG_PORT_DEFAULT: "0" })).toEqual([0]);
    expect(portCandidates(4777, { PG_PORT_DEFAULT: "bogus" })).toEqual([4777, 0]);

    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const busy = (blocker.address() as net.AddressInfo).port;
    const e: NodeJS.ProcessEnv = { ...env(), PG_PORT_DEFAULT: String(busy) };
    // Sticky port busy too: the daemon still starts, on a random port, and remembers it.
    fs.writeFileSync(path.join(e.PG_HOME!, "port"), `${busy}\n`);
    const first = await startDaemon({ env: e });
    expect(first.port).not.toBe(busy);
    const sticky = first.port;
    await first.close();
    const second = await startDaemon({ env: e });
    expect(second.port).toBe(sticky);
    await second.close();
  });
});
