import fs from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API, type ListReposResponse } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { daemonLogPath, readDaemonInfo, writeDaemonInfo } from "../src/config/daemon-info.js";
import { DaemonLock, isDaemonLock } from "../src/config/instance-lock.js";
import { getPaths, type PgPaths } from "../src/config/paths.js";
import { writeToken } from "../src/config/token.js";
import { VERSION } from "../src/config/version.js";
import { absoluteExecArgv, DaemonVersionMismatch, ensureDaemon, findDaemon, registerRepo } from "../src/daemon/client.js";
import { startDaemon } from "../src/daemon/start.js";
import { processStartTime } from "../src/util/process.js";
import { createTempRepo, fakeClaudeEnv, stopDaemonOf, tempDir, waitFor } from "./helpers.js";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
/** The real CLI through tsx (the detached daemon runs with cwd PG_HOME, so every path is absolute). */
const CLI_COMMAND = [process.execPath, "--conditions=source", "--import", TSX, path.join(SERVER_SRC, "src/cli/index.ts")];

describe("daemon client (DESIGN §4.1 items 3 and 4)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function home(): { env: NodeJS.ProcessEnv; paths: PgPaths; root: string } {
    const t = tempDir("pg-client-");
    cleanups.push(t.cleanup);
    const env = { ...process.env, ...fakeClaudeEnv(t.dir), PG_DAEMON_SHELL_ENV: "0" };
    return { env, paths: getPaths(env), root: t.dir };
  }

  async function listen(server: Server | net.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  it("never sends the token to an impostor on the recorded port", async () => {
    const { paths } = home();
    const seen: IncomingHttpHeaders[] = [];
    const impostor = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      // Right shape, the recorded pid, but it cannot know the token.
      res.end(JSON.stringify({ pid: process.pid, serverVersion: VERSION, proof: "forged" }));
    });
    const port = await listen(impostor);
    writeToken(paths, "the-real-token");
    writeDaemonInfo(paths, { version: 2, pid: process.pid, pidStart: processStartTime(process.pid)!, port, serverVersion: VERSION, startedAt: Date.now() });

    expect(await findDaemon(paths)).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain("the-real-token");
  });

  it("verifies a real daemon, then talks to it with the token; another version is a mismatch", async () => {
    const { env, paths } = home();
    const daemon = await startDaemon({ port: 0, env });
    cleanups.push(() => daemon.close());
    const conn = await findDaemon(paths, { version: VERSION });
    expect(conn).toMatchObject({ origin: daemon.origin, token: daemon.ctx.getToken(), info: { pid: process.pid, port: daemon.port } });
    const { repo, cleanup } = createTempRepo();
    cleanups.push(cleanup);
    const summary = await registerRepo(conn!.client, repo);
    expect((await conn!.client.get<ListReposResponse>(API.repos)).repos.map((r) => r.id)).toEqual([summary.id]);

    const err = await findDaemon(paths, { version: "0.0.0-other" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonVersionMismatch);
    expect((err as Error).message).toBe(`promptgraph ${VERSION} is running (this is 0.0.0-other); run promptgraph stop, then retry`);

    // A rotated token on disk that the daemon does not know: the proof fails, nothing is sent.
    writeToken(paths, "not-the-daemons-token");
    expect(await findDaemon(paths)).toBeNull();
  });

  /** A fake CLI that records how it was started, prints a line and exits with `code` (after `delay` s). */
  function fakeCli(root: string, code: number, delay = 0): { command: string[]; record: string } {
    const record = path.join(root, "spawned.txt");
    const script = path.join(root, "fake-cli.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nprintf 'args=%s\\n' "$*" > "${record}"\nprintf 'cwd=%s\\n' "$(pwd)" >> "${record}"\nenv >> "${record}"\necho "fake daemon output"\nsleep ${delay}\nexit ${code}\n`,
      { mode: 0o755 },
    );
    return { command: ["/bin/sh", script], record };
  }

  it("spawns `daemon` with --port only when one is given, in PG_HOME, with the sanitised env", async () => {
    const { env, paths, root } = home();
    const cli = fakeCli(root, 1);
    const caller = { ...env, FOO_SECRET: "s3cret", LD_LIBRARY_PATH: "/appimage/lib" };
    await expect(ensureDaemon({ paths, serverCommand: cli.command, env: caller, timeoutMs: 5000, pollMs: 50 })).rejects.toThrow(
      /exited before it was ready \(code 1\)[\s\S]*fake daemon output/,
    );
    let spawned = fs.readFileSync(cli.record, "utf8");
    expect(spawned).toContain("args=daemon\n");
    expect(spawned).toContain(`cwd=${paths.home}\n`);
    expect(spawned).toContain(`PG_HOME=${paths.home}\n`);
    expect(spawned).not.toContain("FOO_SECRET");
    expect(spawned).not.toContain("LD_LIBRARY_PATH");
    expect(fs.readFileSync(daemonLogPath(paths), "utf8")).toContain("fake daemon output");

    await expect(ensureDaemon({ paths, serverCommand: cli.command, env: caller, port: 5123, timeoutMs: 5000, pollMs: 50 })).rejects.toThrow("code 1");
    spawned = fs.readFileSync(cli.record, "utf8");
    expect(spawned).toContain("args=daemon --port 5123\n");
  });

  it("keeps polling when its child lost the lock (exit 3) and another daemon becomes ready", async () => {
    const { env, paths, root } = home();
    const cli = fakeCli(root, 3);
    // Another daemon starting: it holds the lock but has no record yet.
    const lock = await DaemonLock.acquire(paths);
    if (!isDaemonLock(lock)) throw new Error("lock held");
    const ensured = ensureDaemon({ paths, serverCommand: cli.command, env, timeoutMs: 10_000, pollMs: 50 });
    await waitFor(() => fs.existsSync(cli.record));
    await new Promise((r) => setTimeout(r, 500));
    await lock.release();
    const daemon = await startDaemon({ port: 0, env });
    cleanups.push(() => daemon.close());
    const conn = await ensured;
    expect(conn).toMatchObject({ started: false, info: { pid: process.pid, port: daemon.port } });
  });

  it("spawns again once a stopping daemon released the lock its first child lost", async () => {
    const { env, paths, root } = home();
    const count = path.join(root, "count.txt");
    const script = path.join(root, "fake-cli.sh");
    // First start: the lock is held (exit 3). Second start: fails visibly, so the test needs no real daemon.
    fs.writeFileSync(script, `#!/bin/sh\necho x >> "${count}"\nif [ "$(wc -l < "${count}")" -eq 1 ]; then exit 3; fi\necho "second start"\nexit 1\n`, { mode: 0o755 });
    const lock = await DaemonLock.acquire(paths);
    if (!isDaemonLock(lock)) throw new Error("lock held");
    const ensured = ensureDaemon({ paths, serverCommand: ["/bin/sh", script], env, timeoutMs: 10_000, pollMs: 50 });
    await waitFor(() => fs.existsSync(count));
    await new Promise((r) => setTimeout(r, 300));
    // Still held: it waits instead of spawning again.
    expect(fs.readFileSync(count, "utf8")).toBe("x\n");
    await lock.release();
    await expect(ensured).rejects.toThrow(/exited before it was ready \(code 1\)[\s\S]*second start/);
    expect(fs.readFileSync(count, "utf8")).toBe("x\nx\n");
  });

  it("starts a real detached daemon even when PG_PORT_DEFAULT is taken", { timeout: 40_000 }, async () => {
    const { env, paths } = home();
    const busy = await listen(net.createServer());
    cleanups.push(() => stopDaemonOf(paths));
    const conn = await ensureDaemon({ paths, serverCommand: CLI_COMMAND, env: { ...env, PG_PORT_DEFAULT: String(busy) }, version: VERSION });
    expect(conn.started).toBe(true);
    expect(conn.info.pid).not.toBe(process.pid);
    expect(conn.info.port).not.toBe(busy);
    expect(fs.readFileSync(daemonLogPath(paths), "utf8")).toMatch(/Listening: http:\/\/127\.0\.0\.1:\d+ \(pid \d+, promptgraph /);
    // A second ensure reuses it.
    const again = await ensureDaemon({ paths, serverCommand: CLI_COMMAND, env, version: VERSION });
    expect(again).toMatchObject({ started: false, info: { pid: conn.info.pid } });
    expect(readDaemonInfo(paths)?.pid).toBe(conn.info.pid);
  });
});

describe("absoluteExecArgv", () => {
  it("makes loader specifiers absolute against the cwd, in both flag forms, and keeps everything else", () => {
    const tsxUrl = pathToFileURL(createRequire(path.join(SERVER_SRC, "noop.js")).resolve("tsx")).href;
    const local = path.join(SERVER_SRC, "test", "helpers.ts");
    const argv = absoluteExecArgv(
      ["--conditions=source", "--import", "tsx", "--import=tsx", "--loader", "./test/helpers.ts", "-r", "./test/helpers.ts", "--import", "data:text/javascript,0", "--import", "/abs/x.mjs", "--import", "no-such-pkg-pg"],
      SERVER_SRC,
    );
    expect(argv).toEqual([
      "--conditions=source",
      "--import",
      tsxUrl,
      `--import=${tsxUrl}`,
      "--loader",
      pathToFileURL(local).href,
      "-r",
      local,
      "--import",
      "data:text/javascript,0",
      "--import",
      "/abs/x.mjs",
      "--import",
      "no-such-pkg-pg",
    ]);
  });
});
