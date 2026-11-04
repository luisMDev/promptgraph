import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DAEMON_RESTART_PROGRESS_PREFIX,
  EXIT_VERSION_MISMATCH,
  OpenMismatchResultSchema,
  OpenUrlResultSchema,
  type VersionMismatchPolicy,
} from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli/args.js";
import { runOpen } from "../../src/cli/commands/open.js";
import { defaultDeps, type CliDeps } from "../../src/cli/deps.js";
import { readDaemonInfo } from "../../src/config/daemon-info.js";
import { getPaths, type PgPaths } from "../../src/config/paths.js";
import { tokenPath } from "../../src/config/token.js";
import { VERSION } from "../../src/config/version.js";
import { desktopPaths } from "../../src/desktop/paths.js";
import { installRuntime } from "../../src/desktop/runtime.js";
import { isSameProcess } from "../../src/util/process.js";
import { desktopEnv, makeRuntime } from "../desktop-fixtures.js";
import { createTempRepo, fakeClaudeEnv, stopDaemonOf, tempDir } from "../helpers.js";
import { chainGraph, until } from "./harness.js";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
/** The real CLI through tsx; every path is absolute because a detached daemon runs with cwd PG_HOME. */
const CLI = [process.execPath, "--conditions=source", "--import", TSX, path.join(SERVER_SRC, "src/cli/index.ts")];
const OPENED = /^Opened (\S+): http:\/\/127\.0\.0\.1:(\d+)\/r\/(\S+)$/m;

const OLDER = "0.0.1";
const NEWER = "99.0.0";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Home {
  env: NodeJS.ProcessEnv;
  paths: PgPaths;
  root: string;
}

/**
 * `open --on-version-mismatch` against real detached daemons of another version (PG_VERSION_OVERRIDE)
 * under a temporary PG_HOME, and the runtime activation that follows (DESIGN §4.3, §20.9).
 */
describe("e2e: daemon handover (open --on-version-mismatch)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function home(): Home {
    const t = tempDir("pg-handover-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...fakeClaudeEnv(t.dir),
      ...desktopEnv(t.dir),
      PG_PORT_DEFAULT: "0",
      PG_DAEMON_SHELL_ENV: "0",
    };
    delete env.PROMPTGRAPH_REPO;
    delete env.PG_VERSION_OVERRIDE;
    const paths = getPaths(env);
    cleanups.push(t.cleanup);
    cleanups.push(() => stopDaemonOf(paths));
    return { env, paths, root: t.dir };
  }

  function repo(): string {
    const r = createTempRepo("pg-handover-repo-");
    cleanups.push(r.cleanup);
    return r.repo;
  }

  function run(h: Home, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(CLI[0]!, [...CLI.slice(1), ...args], { cwd: h.root, env: { ...h.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 80_000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /** A detached daemon of `version` (started by a CLI of that version), with `dir` registered. */
  async function daemonOf(h: Home, version: string, dir: string): Promise<{ pid: number; pidStart: number; port: number; repoId: string }> {
    const res = await run(h, [dir, "--no-open"], { PG_VERSION_OVERRIDE: version });
    expect(res.code, res.stderr).toBe(0);
    const m = OPENED.exec(res.stdout)!;
    const info = readDaemonInfo(h.paths)!;
    expect(info.serverVersion).toBe(version);
    return { pid: info.pid, pidStart: info.pidStart, port: Number(m[2]), repoId: m[3]! };
  }

  function api(h: Home, port: number, method: string, route: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${fs.readFileSync(tokenPath(h.paths), "utf8").trim()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Starts a run whose shell step sleeps, and waits until it is running. */
  async function startSleepingRun(h: Home, port: number, repoId: string): Promise<string> {
    const base = `/api/repos/${repoId}`;
    const graph = chainGraph("sleepy", [{ id: "nap", type: "shell", config: { run: "sleep 60" } }]);
    expect((await api(h, port, "PUT", `${base}/graphs/sleepy`, graph)).status).toBe(200);
    const started = (await (await api(h, port, "POST", `${base}/graphs/sleepy/runs`, {})).json()) as { run: { id: string } };
    await until(async () => {
      const detail = (await (await api(h, port, "GET", `${base}/runs/${started.run.id}`)).json()) as { run: { status: string }; nodeRuns: Array<{ status: string }> };
      return detail.run.status === "running" && detail.nodeRuns.some((n) => n.status === "running");
    }, 20_000);
    return started.run.id;
  }

  const openArgs = (dir: string, policy: VersionMismatchPolicy) => ["open", dir, "--print-url", "--json", "--on-version-mismatch", policy];
  const lines = (s: string) => s.split("\n").filter(Boolean);

  it("usage: --on-version-mismatch needs --json and the desktop commands need --json (exit 2)", { timeout: 30_000 }, async () => {
    const h = home();
    for (const args of [["open", "--on-version-mismatch", "auto"], ["desktop", "install"], ["desktop", "shim", "status"]]) {
      const res = await run(h, args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("requires --json");
    }
    const help = await run(h, ["--help"]);
    expect(help.stdout).not.toMatch(/desktop (install|shim)/);
  });

  it("auto: an older idle daemon is stopped and this version started; the progress line is on stderr", { timeout: 90_000 }, async () => {
    const h = home();
    const r = repo();
    const old = await daemonOf(h, OLDER, r);
    const res = await run(h, openArgs(r, "auto"));
    expect(res.code, res.stderr).toBe(0);
    expect(lines(res.stdout)).toHaveLength(1);
    const result = OpenUrlResultSchema.parse(JSON.parse(res.stdout));
    expect(result).toMatchObject({ cliVersion: VERSION, repoId: old.repoId });
    expect(res.stderr).toContain(`${DAEMON_RESTART_PROGRESS_PREFIX} (${OLDER} → ${VERSION})…`);
    expect(isSameProcess(old.pid, old.pidStart)).toBe(false);
    const info = readDaemonInfo(h.paths)!;
    expect(info.pid).not.toBe(old.pid);
    expect(info.serverVersion).toBe(VERSION);
    // The verified hello agrees: plain `open` (which refuses another version) works now.
    const plain = await run(h, ["open", r, "--json"]);
    expect(plain.code, plain.stderr).toBe(0);
  });

  it("auto: an older daemon with a running run is left alone and the caller decides (exit 4); restart then hands over", { timeout: 120_000 }, async () => {
    const h = home();
    const r = repo();
    const old = await daemonOf(h, OLDER, r);
    const runId = await startSleepingRun(h, old.port, old.repoId);

    const res = await run(h, openArgs(r, "auto"));
    expect(res.code, res.stderr).toBe(EXIT_VERSION_MISMATCH);
    expect(lines(res.stdout)).toHaveLength(1);
    const { mismatch } = OpenMismatchResultSchema.parse(JSON.parse(res.stdout));
    expect(mismatch).toMatchObject({ serverVersion: OLDER, cliVersion: VERSION, daemonIsOlder: true });
    expect(mismatch.runningRuns).toBeGreaterThanOrEqual(1);
    expect(res.stderr).not.toContain(DAEMON_RESTART_PROGRESS_PREFIX);
    expect(isSameProcess(old.pid, old.pidStart)).toBe(true);
    expect(readDaemonInfo(h.paths)).toMatchObject({ pid: old.pid, serverVersion: OLDER });

    const restarted = await run(h, openArgs(r, "restart"));
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(OpenUrlResultSchema.parse(JSON.parse(restarted.stdout))).toMatchObject({ cliVersion: VERSION, repoId: old.repoId });
    expect(restarted.stderr).toContain(`${DAEMON_RESTART_PROGRESS_PREFIX} (${OLDER} → ${VERSION})…`);
    expect(isSameProcess(old.pid, old.pidStart)).toBe(false);
    const info = readDaemonInfo(h.paths)!;
    expect(info.serverVersion).toBe(VERSION);
    // The interrupted run paused and is resumable on the new daemon.
    const detail = (await (await api(h, info.port, "GET", `/api/repos/${old.repoId}/runs/${runId}`)).json()) as { run: { status: string } };
    expect(detail.run.status).toBe("paused");
  });

  it("auto: a newer daemon is never stopped (exit 4, daemonIsOlder false); attach opens it as it is", { timeout: 90_000 }, async () => {
    const h = home();
    const r = repo();
    const newer = await daemonOf(h, NEWER, r);
    const res = await run(h, openArgs(r, "auto"));
    expect(res.code, res.stderr).toBe(EXIT_VERSION_MISMATCH);
    expect(OpenMismatchResultSchema.parse(JSON.parse(res.stdout)).mismatch).toEqual({ serverVersion: NEWER, cliVersion: VERSION, runningRuns: 0, daemonIsOlder: false });
    expect(isSameProcess(newer.pid, newer.pidStart)).toBe(true);

    const attached = await run(h, openArgs(r, "attach"));
    expect(attached.code, attached.stderr).toBe(0);
    const result = OpenUrlResultSchema.parse(JSON.parse(attached.stdout));
    expect(result).toMatchObject({ cliVersion: VERSION, port: newer.port, repoId: newer.repoId });
    expect(new URL(result.url).origin).toBe(`http://127.0.0.1:${newer.port}`);
    expect(new URL(result.url).pathname).toBe("/login");
    expect(isSameProcess(newer.pid, newer.pidStart)).toBe(true);
    // The login URL works on the old daemon.
    expect((await fetch(result.url, { redirect: "manual" })).status).toBe(302);
  });

  describe("runtime activation (DESIGN §4.3, §20.7)", () => {
    /** Two installed fixture runtimes, A current; deps of an in-process CLI that runs from B. */
    async function runtimes(h: Home) {
      const okCheck = async () => undefined;
      const a = path.join(h.root, "bundle-a");
      const b = path.join(h.root, "bundle-b");
      makeRuntime(a, { version: OLDER });
      makeRuntime(b, { version: VERSION });
      const ra = await installRuntime({ from: a, env: h.env, selfCheck: okCheck });
      const rb = await installRuntime({ from: b, env: h.env, selfCheck: okCheck });
      expect(rb.current).toBe(path.basename(ra.root));
      const out: string[] = [];
      const err: string[] = [];
      const deps: CliDeps = {
        ...defaultDeps(h.env),
        cwd: h.root,
        stdout: (l) => void out.push(l),
        stderr: (l) => void err.push(l),
        serverCommand: CLI,
        version: VERSION,
        runtimeRoot: rb.root,
      };
      const current = () => fs.readlinkSync(desktopPaths(h.env).currentLink);
      return { a: path.basename(ra.root), b: path.basename(rb.root), bundleB: b, deps, out, err, current };
    }

    const open = (deps: CliDeps, dir: string, policy: VersionMismatchPolicy) => runOpen(parseCliArgs(openArgs(dir, policy)), deps);

    it("after auto and restart, current points at the runtime of the CLI whose daemon now runs", { timeout: 120_000 }, async () => {
      const h = home();
      const r = repo();
      const rt = await runtimes(h);
      await daemonOf(h, OLDER, r);
      expect(await open(rt.deps, r, "auto"), rt.err.join("\n")).toBe(0);
      expect(rt.current()).toBe(rt.b);
      expect(rt.err.filter((l) => l.startsWith("warning:"))).toEqual([]);

      // restart (from a daemon of another version again), after current moved back by hand.
      fs.unlinkSync(desktopPaths(h.env).currentLink);
      fs.symlinkSync(rt.a, desktopPaths(h.env).currentLink);
      await run(h, ["stop"]);
      await daemonOf(h, NEWER, r);
      expect(await open(rt.deps, r, "restart"), rt.err.join("\n")).toBe(0);
      expect(rt.current()).toBe(rt.b);
      expect(readDaemonInfo(h.paths)!.serverVersion).toBe(VERSION);
    });

    it("current follows the CLI's own runtime directory even when open's environment names another data directory", { timeout: 90_000 }, async () => {
      // `desktop install` runs with the app's environment, `open` through the login shell, whose start-up
      // files may export an XDG_DATA_HOME the app never saw.
      const h = home();
      const r = repo();
      const rt = await runtimes(h);
      await daemonOf(h, OLDER, r);
      const other = path.join(h.root, "other-data");
      const deps: CliDeps = { ...rt.deps, env: { ...rt.deps.env, XDG_DATA_HOME: other } };
      expect(await open(deps, r, "auto"), rt.err.join("\n")).toBe(0);
      expect(rt.current()).toBe(rt.b);
      expect(rt.err.filter((l) => l.startsWith("warning:"))).toEqual([]);
      expect(fs.existsSync(path.join(other, "promptgraph"))).toBe(false);
    });

    it("a bundled runtime that is not installed (the AppImage's mount) warns and never touches current", { timeout: 90_000 }, async () => {
      const h = home();
      const r = repo();
      const rt = await runtimes(h);
      await daemonOf(h, OLDER, r);
      expect(await open({ ...rt.deps, runtimeRoot: rt.bundleB }, r, "auto"), rt.err.join("\n")).toBe(0);
      expect(rt.current()).toBe(rt.a);
      expect(rt.err).toContainEqual(expect.stringMatching(/^warning: .*bundle-b is a bundled promptgraph runtime but not an installed one/));
    });

    it("attach and a mismatch exit leave current alone", { timeout: 90_000 }, async () => {
      const h = home();
      const r = repo();
      const rt = await runtimes(h);
      await daemonOf(h, NEWER, r);
      expect(await open(rt.deps, r, "auto")).toBe(EXIT_VERSION_MISMATCH);
      expect(rt.current()).toBe(rt.a);
      expect(await open(rt.deps, r, "attach")).toBe(0);
      expect(rt.current()).toBe(rt.a);
      expect(rt.out).toHaveLength(2);
    });

    it("a CLI that is not an installed runtime never touches current", { timeout: 90_000 }, async () => {
      const h = home();
      const r = repo();
      const rt = await runtimes(h);
      await daemonOf(h, OLDER, r);
      // The real CLI (a checkout, not a runtime) hands over with auto.
      const res = await run(h, openArgs(r, "auto"));
      expect(res.code, res.stderr).toBe(0);
      expect(readDaemonInfo(h.paths)!.serverVersion).toBe(VERSION);
      expect(rt.current()).toBe(rt.a);
      expect(res.stderr).not.toContain("warning:");
    });
  });
});
