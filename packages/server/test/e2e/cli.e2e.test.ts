import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ListReposResponseSchema, ListSessionsResponseSchema, OpenUrlResultSchema } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { daemonInfoPath, daemonLogPath, readDaemonInfo, writeDaemonInfo } from "../../src/config/daemon-info.js";
import { DaemonLock, isDaemonLock } from "../../src/config/instance-lock.js";
import { getPaths, type PgPaths } from "../../src/config/paths.js";
import { tokenPath, writeToken } from "../../src/config/token.js";
import { VERSION } from "../../src/config/version.js";
import { isProcessAlive, isSameProcess, processStartTime } from "../../src/util/process.js";
import { createTempRepo, fakeClaudeEnv, stopDaemonOf, tempDir, waitFor } from "../helpers.js";
import { chainGraph, until } from "./harness.js";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
/** The real CLI through tsx; every path is absolute because a detached daemon runs with cwd PG_HOME. */
const CLI = [process.execPath, "--conditions=source", "--import", TSX, path.join(SERVER_SRC, "src/cli/index.ts")];

const OPENED = /^Opened (\S+): http:\/\/127\.0\.0\.1:(\d+)\/r\/(\S+)$/m;
const LISTENING = /^Listening: http:\/\/127\.0\.0\.1:(\d+) \(pid (\d+), promptgraph (\S+)\)$/m;

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

/** Child-process tests of the `promptgraph` bin (DESIGN §4, CONTRACTS §4 cli/). */
describe("e2e: promptgraph CLI", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** A throwaway PG_HOME (+ fake claude); its daemon, if any, is stopped after the test. */
  function home(extra: Record<string, string> = {}): Home {
    const t = tempDir("pg-cli-e2e-");
    const env: NodeJS.ProcessEnv = { ...process.env, ...fakeClaudeEnv(t.dir), PG_PORT_DEFAULT: "0", PG_DAEMON_SHELL_ENV: "0", ...extra };
    delete env.PROMPTGRAPH_REPO;
    if (!extra.PG_VERSION_OVERRIDE) delete env.PG_VERSION_OVERRIDE;
    const paths = getPaths(env);
    cleanups.push(t.cleanup);
    cleanups.push(() => stopDaemonOf(paths));
    return { env, paths, root: t.dir };
  }

  function repo(prefix = "pg-cli-repo-"): string {
    const r = createTempRepo(prefix);
    cleanups.push(r.cleanup);
    return r.repo;
  }

  function run(h: Home, args: string[], cwd: string = h.root): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(CLI[0]!, [...CLI.slice(1), ...args], { cwd, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /** A long-running CLI child (`daemon`); killed after the test. */
  function spawnLong(h: Home, args: string[]): { child: ChildProcess; output: () => string } {
    const child = spawn(CLI[0]!, [...CLI.slice(1), ...args], { cwd: h.root, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (output += d.toString()));
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return { child, output: () => output };
  }

  function token(h: Home): string {
    return fs.readFileSync(tokenPath(h.paths), "utf8").trim();
  }

  function api(h: Home, port: number, method: string, route: string, body?: unknown, bearer: string = token(h)): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** `promptgraph <repo> --no-open`: starts (or reuses) the detached daemon and registers the repository. */
  async function openRepo(h: Home, dir: string, extra: string[] = []): Promise<{ name: string; port: number; repoId: string; result: CliResult }> {
    const result = await run(h, [dir, "--no-open", ...extra]);
    expect(result.code, result.stderr).toBe(0);
    const m = OPENED.exec(result.stdout);
    expect(m, result.stdout).not.toBeNull();
    return { name: m![1]!, port: Number(m![2]), repoId: m![3]!, result };
  }

  it("`daemon` runs the daemon in the terminal and prints Listening", { timeout: 60_000 }, async () => {
    const h = home();
    const d = spawnLong(h, ["daemon"]);
    const m = await waitFor(() => {
      if (d.child.exitCode !== null) throw new Error(`daemon exited (${d.child.exitCode}):\n${d.output()}`);
      return LISTENING.exec(d.output());
    }, 30_000);
    expect(Number(m[2])).toBe(d.child.pid);
    expect(m[3]).toBe(VERSION);
    expect(readDaemonInfo(h.paths)).toMatchObject({ pid: d.child.pid, port: Number(m[1]) });
    d.child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      d.child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    expect(exit, d.output()).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(daemonInfoPath(h.paths))).toBe(false);
  });

  it("`<repo> --no-open` starts a detached daemon, registers and exits; ls, open --json and stop", { timeout: 90_000 }, async () => {
    const h = home();
    const r = repo();
    // No daemon yet: ls never starts one.
    const before = await run(h, ["ls"]);
    expect(before).toMatchObject({ code: 1, stdout: "promptgraph is not running\n" });
    expect(fs.existsSync(daemonInfoPath(h.paths))).toBe(false);

    const { name, port, repoId, result } = await openRepo(h, r);
    expect(name).toBe(path.basename(r));
    expect(result.stdout).toContain("Started the promptgraph daemon");
    expect(result.stdout).not.toContain(token(h));
    const info = readDaemonInfo(h.paths)!;
    expect(info).toMatchObject({ port, serverVersion: VERSION });
    expect(isProcessAlive(info.pid)).toBe(true);
    expect(fs.readFileSync(daemonLogPath(h.paths), "utf8")).toMatch(LISTENING);

    // ls --json is ListReposResponse; the human form lists the repository.
    const json = await run(h, ["ls", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout.trim().split("\n")).toHaveLength(1);
    const listed = ListReposResponseSchema.parse(JSON.parse(json.stdout));
    expect(listed.repos.map((x) => [x.id, x.path])).toEqual([[repoId, fs.realpathSync(r)]]);
    const table = await run(h, ["ls"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain(`promptgraph ${VERSION} · pid ${info.pid} · http://127.0.0.1:${port} · up `);
    expect(table.stdout).toMatch(new RegExp(`^${name}\\s+${repoId}\\s+0\\s+0\\s+0\\s+0\\s+${fs.realpathSync(r)}$`, "m"));

    // The same repository again reuses the daemon; an explicit other port is ignored with a warning.
    const again = await openRepo(h, r, ["--port", "1"]);
    expect(again).toMatchObject({ port, repoId });
    expect(again.result.stdout).not.toContain("Started");
    expect(again.result.stderr).toContain(`the promptgraph daemon is already running on port ${port}; --port 1 was not used`);

    // open --print-url --json: exactly one OpenUrlResult line, whose URL signs a browser in once.
    const opened = await run(h, ["open", r, "--print-url", "--json"]);
    expect(opened.code, opened.stderr).toBe(0);
    const lines = opened.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const res = OpenUrlResultSchema.parse(JSON.parse(lines[0]!));
    expect(res).toMatchObject({ v: 1, cliVersion: VERSION, port, repoId });
    expect(res.url.startsWith(`http://127.0.0.1:${port}/login?code=`)).toBe(true);
    expect(res.url).toContain(`&next=%2Fr%2F${repoId}`);
    expect(opened.stdout).not.toContain(token(h));
    const redeemed = await fetch(res.url, { redirect: "manual" });
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe(`/r/${repoId}`);
    expect(redeemed.headers.get("set-cookie")).toMatch(/^pg_session=/);
    expect((await fetch(res.url, { redirect: "manual" })).status).toBe(401);

    // By repoId, Home, --next and --web-port.
    const byId = OpenUrlResultSchema.parse(JSON.parse((await run(h, ["open", repoId, "--json"])).stdout));
    expect(byId.repoId).toBe(repoId);
    const homeUrl = await run(h, ["open", "--print-url"]);
    expect(homeUrl.code).toBe(0);
    expect(homeUrl.stdout.trim()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/login\\?code=[A-Za-z0-9_-]+&next=%2F$`));
    const dev = OpenUrlResultSchema.parse(JSON.parse((await run(h, ["open", r, "--json", "--web-port", "5173", "--next", `/r/${repoId}/graphs/g`])).stdout));
    expect(dev).toMatchObject({ port: 5173, repoId });
    expect(dev.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:5173/login\\?code=[^&]+&next=%2Fr%2F${repoId}%2Fgraphs%2Fg$`));
    expect(await run(h, ["open", "--next", "//evil.com"])).toMatchObject({ code: 2 });
    const unknown = await run(h, ["open", path.join(h.root, "nowhere")]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("is neither a git repository nor a registered repository id");

    // stop: SIGTERM, wait for the pid, record gone.
    const stopped = await run(h, ["stop"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain(`Stopping promptgraph (pid ${info.pid})`);
    expect(stopped.stdout).toContain("Stopped.");
    expect(isSameProcess(info.pid, info.pidStart)).toBe(false);
    expect(fs.existsSync(daemonInfoPath(h.paths))).toBe(false);
    expect(await run(h, ["stop"])).toMatchObject({ code: 1, stdout: "promptgraph is not running\n" });
    expect(await run(h, ["sessions"])).toMatchObject({ code: 1, stderr: "error: promptgraph is not running\n" });
  });

  it("two concurrent `<repo> --no-open` with no daemon yield one daemon and both exit 0", { timeout: 60_000 }, async () => {
    const h = home();
    const [a, b] = await Promise.all([openRepo(h, repo("pg-cli-a-")), openRepo(h, repo("pg-cli-b-"))]);
    expect(a.port).toBe(b.port);
    expect(a.repoId).not.toBe(b.repoId);
    const log = fs.readFileSync(daemonLogPath(h.paths), "utf8");
    expect(log.match(new RegExp(LISTENING.source, "gm"))).toHaveLength(1);
    const listed = ListReposResponseSchema.parse(JSON.parse((await run(h, ["ls", "--json"])).stdout));
    expect(listed.repos.map((x) => x.id).sort()).toEqual([a.repoId, b.repoId].sort());
  });

  it("a busy default port falls back to another port, which the next start reuses", { timeout: 60_000 }, async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const busy = (blocker.address() as net.AddressInfo).port;
    const h = home({ PG_PORT_DEFAULT: String(busy) });
    const r = repo();
    const first = await openRepo(h, r);
    expect(first.port).not.toBe(busy);
    expect((await run(h, ["stop"])).code).toBe(0);
    const second = await openRepo(h, r);
    expect(second).toMatchObject({ port: first.port, repoId: first.repoId });
  });

  it("rm is refused while a run is active and works with --force; close is an alias", { timeout: 60_000 }, async () => {
    const h = home();
    const r = repo();
    const { port, repoId, name } = await openRepo(h, r);
    const base = `/api/repos/${repoId}`;
    const graph = chainGraph("hang", [{ id: "work", type: "prompt", config: { prompt: "[[hang]] keep working" } }]);
    expect((await api(h, port, "PUT", `${base}/graphs/hang`, graph)).status).toBe(200);
    const started = (await (await api(h, port, "POST", `${base}/graphs/hang/runs`, {})).json()) as { run: { id: string } };
    await until(async () => {
      const detail = (await (await api(h, port, "GET", `${base}/runs/${started.run.id}`)).json()) as { run: { status: string }; nodeRuns: Array<{ status: string }> };
      return detail.run.status === "running" && detail.nodeRuns.some((n) => n.status === "running");
    }, 20_000);

    const refused = await run(h, ["rm", r]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`${name} has a running run; cancel it first, or pass --force`);
    expect(ListReposResponseSchema.parse(await (await api(h, port, "GET", "/api/repos")).json()).repos).toHaveLength(1);

    const forced = await run(h, ["close", repoId, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toContain(`Removed ${name} (${repoId})`);
    expect(ListReposResponseSchema.parse(await (await api(h, port, "GET", "/api/repos")).json()).repos).toEqual([]);
    const gone = await run(h, ["rm", r]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("is not a registered repository");
    // Its run was interrupted and paused (resumable): adding the repository back gives it back.
    const back = await openRepo(h, r);
    expect(back.repoId).toBe(repoId);
    const detail = (await (await api(h, port, "GET", `${base}/runs/${started.run.id}`)).json()) as { run: { status: string } };
    expect(detail.run.status).toBe("paused");
  });

  /** Redeems a fresh login URL of `promptgraph open <dir> --json`; returns the `pg_session` cookie pair. */
  async function signIn(h: Home, dir: string): Promise<string> {
    const { url } = OpenUrlResultSchema.parse(JSON.parse((await run(h, ["open", dir, "--json"])).stdout));
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 Firefox/140.0" } });
    expect(res.status).toBe(302);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  function withCookie(port: number, cookie: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/repos`, { headers: { cookie } });
  }

  it("token rotate through a running daemon and offline under the daemon lock", { timeout: 120_000 }, async () => {
    const h = home();
    const r = repo();
    const { port } = await openRepo(h, r);
    const before = await signIn(h, r);
    expect((await withCookie(port, before)).status).toBe(200);
    const old = token(h);
    const rotated = await run(h, ["token", "rotate"]);
    expect(rotated.code, rotated.stderr).toBe(0);
    expect(rotated.stdout).toContain("Token rotated");
    const fresh = token(h);
    expect(fresh).not.toBe(old);
    expect(rotated.stdout + rotated.stderr).not.toContain(fresh);
    expect((await api(h, port, "GET", "/api/repos", undefined, old)).status).toBe(401);
    expect((await api(h, port, "GET", "/api/repos", undefined, fresh)).status).toBe(200);
    expect((await withCookie(port, before)).status).toBe(401);
    expect((await run(h, ["ls"])).code).toBe(0);

    // A session survives a plain restart (same token)...
    const kept = await signIn(h, r);
    expect((await run(h, ["stop"])).code).toBe(0);
    const restarted = await openRepo(h, r);
    expect((await withCookie(restarted.port, kept)).status).toBe(200);

    // ...but not an offline rotation: the file is rewritten under the daemon lock, and the next daemon
    // start sees a token other than the one its sessions were issued under and deletes them.
    expect((await run(h, ["stop"])).code).toBe(0);
    const offlineOld = token(h);
    const offline = await run(h, ["token", "rotate"]);
    expect(offline.code, offline.stderr).toBe(0);
    expect(offline.stdout).toContain("Token rotated");
    expect(token(h)).not.toBe(offlineOld);
    expect(offline.stdout + offline.stderr).not.toContain(token(h));
    expect(fs.statSync(tokenPath(h.paths)).mode & 0o777).toBe(0o600);
    const again = await openRepo(h, r);
    expect((await withCookie(again.port, kept)).status).toBe(401);
    expect(ListSessionsResponseSchema.parse(JSON.parse((await run(h, ["sessions", "--json"])).stdout)).sessions).toEqual([]);

    // A token file replaced by hand has the same effect.
    const handKept = await signIn(h, r);
    expect((await run(h, ["stop"])).code).toBe(0);
    writeToken(h.paths, "hand-written-token-value-0123456789abcdefghij");
    const byHand = await openRepo(h, r);
    expect((await withCookie(byHand.port, handKept)).status).toBe(401);
    expect((await run(h, ["stop"])).code).toBe(0);

    // Lock held but no verified daemon (one starting): refused, the file is untouched.
    const lock = await DaemonLock.acquire(h.paths);
    if (!isDaemonLock(lock)) throw new Error("lock not acquired");
    cleanups.push(() => lock.release());
    const current = token(h);
    const busy = await run(h, ["token", "rotate"]);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain("the promptgraph daemon is starting or unreachable; retry");
    expect(token(h)).toBe(current);
  });

  it("sessions lists redeemed logins; revoke one by id, then --all", { timeout: 60_000 }, async () => {
    const h = home();
    const r = repo();
    const { port } = await openRepo(h, r);
    expect(ListSessionsResponseSchema.parse(JSON.parse((await run(h, ["sessions", "--json"])).stdout)).sessions).toEqual([]);
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) cookies.push(await signIn(h, r));
    const listed = ListSessionsResponseSchema.parse(JSON.parse((await run(h, ["sessions", "--json"])).stdout)).sessions;
    expect(listed).toHaveLength(2);
    // `open --json` is the desktop shell's interface: its sessions say so whatever the user agent.
    expect(listed.map((s) => s.label)).toEqual(["promptgraph desktop", "promptgraph desktop"]);
    const table = await run(h, ["sessions"]);
    expect(table.code).toBe(0);
    for (const s of listed) expect(table.stdout).toContain(s.id);

    const one = await run(h, ["sessions", "revoke", listed[0]!.id.toUpperCase()]);
    expect(one).toMatchObject({ code: 0, stdout: "Revoked 1 session.\n" });
    expect(ListSessionsResponseSchema.parse(JSON.parse((await run(h, ["sessions", "--json"])).stdout)).sessions.map((s) => s.id)).toEqual([listed[1]!.id]);
    expect((await run(h, ["sessions", "revoke", listed[0]!.id])).code).toBe(1);

    // A plain --print-url login is a browser session, labelled from its user agent.
    const printed = (await run(h, ["open", r, "--print-url"])).stdout.trim();
    const browser = await fetch(printed, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 Firefox/140.0" } });
    expect(browser.status).toBe(302);
    cookies.push((browser.headers.get("set-cookie") ?? "").split(";")[0]!);
    const labels = ListSessionsResponseSchema.parse(JSON.parse((await run(h, ["sessions", "--json"])).stdout)).sessions.map((s) => s.label);
    expect(labels.sort()).toEqual(["Firefox", "promptgraph desktop"]);

    expect(await run(h, ["sessions", "revoke", "--all"])).toMatchObject({ code: 0, stdout: "Revoked 2 sessions.\n" });
    expect(ListSessionsResponseSchema.parse(JSON.parse((await run(h, ["sessions", "--json"])).stdout)).sessions).toEqual([]);
    for (const cookie of cookies) expect((await fetch(`http://127.0.0.1:${port}/api/repos`, { headers: { cookie } })).status).toBe(401);
  });

  it("--foreground is refused while a daemon runs; the running daemon is untouched", { timeout: 60_000 }, async () => {
    const h = home();
    const r = repo();
    await openRepo(h, r);
    const first = readDaemonInfo(h.paths)!;
    const res = await run(h, [r, "--foreground", "--no-open"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`promptgraph daemon is already running (pid ${first.pid}`);
    expect(res.stderr).toContain("--foreground needs it stopped");
    expect(readDaemonInfo(h.paths)).toEqual(first);
    expect(isSameProcess(first.pid, first.pidStart)).toBe(true);
  });

  it("--version is global: `mcp --version` prints the version instead of starting the MCP server", { timeout: 30_000 }, async () => {
    const h = home();
    for (const args of [["--version"], ["mcp", "--version"], ["ls", "--version"]]) {
      expect(await run(h, args)).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    }
  });

  it("stop never signals a live process whose start time differs from the record", { timeout: 30_000 }, async () => {
    const h = home();
    const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
    cleanups.push(() => void unrelated.kill("SIGKILL"));
    const pid = unrelated.pid!;
    await waitFor(() => processStartTime(pid) !== null, 5_000);
    writeDaemonInfo(h.paths, { version: 2, pid, pidStart: processStartTime(pid)! + 12345, port: 1, serverVersion: VERSION, startedAt: Date.now() });
    const res = await run(h, ["stop"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain(`promptgraph is not running (removed a stale record of pid ${pid})`);
    expect(fs.existsSync(daemonInfoPath(h.paths))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    expect(isProcessAlive(pid)).toBe(true);
  });

  it("a daemon of another version: open and the repo start exit 1 with the message, ls warns, stop works", { timeout: 60_000 }, async () => {
    const h = home();
    const other = { ...h, env: { ...h.env, PG_VERSION_OVERRIDE: "9.9.9-test" } };
    const d = spawnLong(other, ["daemon"]);
    const m = await waitFor(() => {
      if (d.child.exitCode !== null) throw new Error(`daemon exited (${d.child.exitCode}):\n${d.output()}`);
      return LISTENING.exec(d.output());
    }, 30_000);
    expect(m[3]).toBe("9.9.9-test");
    const r = repo();
    const message = `promptgraph 9.9.9-test is running (this is ${VERSION}); run promptgraph stop, then retry`;

    const opened = await run(h, ["open", r, "--print-url", "--json"]);
    expect(opened).toMatchObject({ code: 1, stdout: "" });
    expect(opened.stderr).toContain(message);
    const started = await run(h, [r, "--no-open"]);
    expect(started.code).toBe(1);
    expect(started.stderr).toContain(message);
    for (const args of [["rm", r], ["sessions"], ["token", "rotate"]]) {
      const res = await run(h, args);
      expect(res.code, args.join(" ")).toBe(1);
      expect(res.stderr).toContain(message);
    }

    const listed = await run(h, ["ls", "--json"]);
    expect(listed.code).toBe(0);
    expect(ListReposResponseSchema.parse(JSON.parse(listed.stdout)).repos).toEqual([]);
    expect(listed.stderr).toContain(`warning: ${message}`);

    const stopped = await run(h, ["stop"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(await new Promise((resolve) => (d.child.exitCode !== null ? resolve(d.child.exitCode) : d.child.once("exit", resolve)))).toBe(0);
  });
});
