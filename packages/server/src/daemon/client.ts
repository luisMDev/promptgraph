import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { API, DaemonHelloResponseSchema, EXIT_DAEMON_LOCKED, type DaemonInfo, type RepoSummary } from "@promptgraph/shared";
import { daemonLogPath, readDaemonInfo, rotateDaemonLog } from "../config/daemon-info.js";
import type { PgPaths } from "../config/paths.js";
import { helloProof, tokenPath } from "../config/token.js";
import { PromptgraphClient } from "../mcp/client.js";
import { tailLines } from "../util/text.js";
import { daemonEnv } from "./daemon-env.js";

/** A daemon of another version is running (DESIGN §4.1 item 4). */
export class DaemonVersionMismatch extends Error {
  constructor(
    readonly running: string,
    readonly client: string,
  ) {
    super(`promptgraph ${running} is running (this is ${client}); run promptgraph stop, then retry`);
  }
}

/** A verified daemon: its record, the token and a Bearer client on its origin. */
export interface DaemonConnection {
  info: DaemonInfo;
  token: string;
  /** http://127.0.0.1:<port> */
  origin: string;
  client: PromptgraphClient;
}

export interface FindDaemonOptions {
  /** The client's version: a daemon of another version throws DaemonVersionMismatch. Omitted: any version. */
  version?: string;
  fetchImpl?: typeof fetch;
  /** Hello timeout. Default 3000 ms. */
  timeoutMs?: number;
}

const HELLO_TIMEOUT_MS = 3000;

function readToken(paths: PgPaths): string | null {
  try {
    return fs.readFileSync(tokenPath(paths), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The running daemon, verified before any credential is sent (DESIGN §4.1 item 3): reads the record
 * (pid alive with its recorded start time) and the token file, calls `GET /api/daemon/hello?nonce=` with
 * no Authorization header and checks the proof and the pid. Null when there is no record, no token or
 * the check fails (a stale record, or something else listening on the recorded port). Re-read on every
 * call: a restarted daemon or a rotated token is picked up.
 * @throws DaemonVersionMismatch when `version` is given and differs from the daemon's.
 */
export async function findDaemon(paths: PgPaths, opts: FindDaemonOptions = {}): Promise<DaemonConnection | null> {
  const info = readDaemonInfo(paths);
  if (!info) return null;
  const token = readToken(paths);
  if (!token) return null;
  const origin = `http://127.0.0.1:${info.port}`;
  const nonce = randomBytes(16).toString("base64url");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let hello;
  try {
    const res = await fetchImpl(`${origin}${API.hello(nonce)}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? HELLO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    hello = DaemonHelloResponseSchema.safeParse(await res.json());
  } catch {
    return null;
  }
  if (!hello.success || hello.data.pid !== info.pid || !sameString(hello.data.proof, helloProof(token, nonce))) return null;
  if (opts.version !== undefined && hello.data.serverVersion !== opts.version) {
    throw new DaemonVersionMismatch(hello.data.serverVersion, opts.version);
  }
  return { info, token, origin, client: new PromptgraphClient(origin, token, opts.fetchImpl) };
}

export interface EnsureDaemonOptions {
  paths: PgPaths;
  /** argv that runs the promptgraph CLI: [node, ...execArgv, cli entry]. `daemon [--port p]` is appended. */
  serverCommand: readonly string[];
  /** Only when the user gave one: the daemon keeps its port fallback otherwise. */
  port?: number;
  /** The caller's environment (sanitised with daemonEnv before it reaches the daemon). */
  env?: NodeJS.ProcessEnv;
  version?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Poll interval. Default 150 ms. */
  pollMs?: number;
}

export interface EnsuredDaemon extends DaemonConnection {
  /** This call spawned it. */
  started: boolean;
  /** The detached daemon's log. */
  logFile: string;
}

/**
 * A verified running daemon, or a new detached one (DESIGN §4.1 item 4): spawns `<serverCommand> daemon
 * [--port p]` with cwd PG_HOME, the sanitised daemonEnv and its output appended to logs/daemon.log
 * (rotated first when above 5 MB), then polls findDaemon. A child exiting with code 3 lost the lock to
 * another spawner: polling goes on. Any other early exit, or the timeout, throws with the log's last 20
 * lines.
 */
export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsuredDaemon> {
  const { paths } = opts;
  const find = () => findDaemon(paths, { version: opts.version, fetchImpl: opts.fetchImpl });
  const logFile = daemonLogPath(paths);
  const existing = await find();
  if (existing) return { ...existing, started: false, logFile };

  const env = await daemonEnv({ caller: { ...(opts.env ?? process.env), PG_HOME: paths.home } });
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  rotateDaemonLog(paths);
  const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const fd = fs.openSync(logFile, "a", 0o600);
  let exited: { code: number | null } | null = null;
  try {
    const [command, ...args] = opts.serverCommand;
    if (!command) throw new Error("ensureDaemon: empty serverCommand");
    const child = spawn(command, [...args, "daemon", ...(opts.port !== undefined ? ["--port", String(opts.port)] : [])], {
      cwd: paths.home,
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.once("exit", (code) => {
      exited = { code };
    });
    child.once("error", (err) => {
      exited = { code: null };
      fs.appendFileSync(logFile, `spawn failed: ${err.message}\n`);
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const pollMs = opts.pollMs ?? 150;
  for (;;) {
    const conn = await find();
    const ended = exited as { code: number | null } | null;
    // A child that exited with 3 lost the lock to another spawner, whose daemon this is.
    if (conn) return { ...conn, started: ended?.code !== EXIT_DAEMON_LOCKED, logFile };
    if (ended && ended.code !== EXIT_DAEMON_LOCKED) {
      throw new Error(`the promptgraph daemon exited before it was ready (code ${ended.code}). Log (${logFile}):\n${tailOf(logFile, logStart)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`the promptgraph daemon did not become ready in time. Log (${logFile}):\n${tailOf(logFile, logStart)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function tailOf(file: string, offset: number): string {
  try {
    return tailLines(fs.readFileSync(file).subarray(offset).toString("utf8").trim(), 20);
  } catch {
    return "";
  }
}

/** POST /api/repos (idempotent): registers and activates the repository. */
export function registerRepo(client: PromptgraphClient, repoPath: string): Promise<RepoSummary> {
  return client.post<RepoSummary>(API.repos, { path: repoPath });
}
