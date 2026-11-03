import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ServerInfo } from "@promptgraph/shared";
import { childEnv } from "../config/child-env.js";
import type { PgPaths } from "../config/paths.js";
import { backgroundServerLogPath, readServerInfo } from "../config/server-info.js";
import { resolveRepoRoot } from "../git/repo.js";
import { tailLines } from "../util/text.js";
import { PromptgraphClient } from "./client.js";

/** Where the MCP server runs and how it reaches promptgraph (§19.2). */
export interface McpEnvironment {
  /** Directory Claude Code started the MCP server in (the project); `PROMPTGRAPH_REPO` overrides it. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  paths: PgPaths;
  /** How to start `promptgraph <repo> --no-open` in the background: argv[0] + leading args. */
  serverCommand: { command: string; args: string[] };
  fetchImpl?: typeof fetch;
}

export interface Connection {
  info: ServerInfo;
  client: PromptgraphClient;
}

/** Git top level per directory: it does not change while the MCP server runs (one git call per dir). */
const repoRoots = new Map<string, Promise<string>>();

export function resolveRepo(mcpEnv: McpEnvironment, repo?: string): Promise<string> {
  const dir = path.resolve(mcpEnv.cwd, repo ?? mcpEnv.env.PROMPTGRAPH_REPO ?? mcpEnv.cwd);
  let root = repoRoots.get(dir);
  if (!root) {
    root = resolveRepoRoot(dir).catch(() => {
      repoRoots.delete(dir);
      throw new Error(`${dir} is not inside a git repository; promptgraph works on git repositories.`);
    });
    repoRoots.set(dir, root);
  }
  return root;
}

/** The live server for `repoPath`, or null. Read on every call: a restart changes port and token. */
export function findServer(mcpEnv: McpEnvironment, repoPath: string): Connection | null {
  const info = readServerInfo(mcpEnv.paths, repoPath);
  if (!info) return null;
  return { info, client: new PromptgraphClient(`http://127.0.0.1:${info.port}`, info.token, mcpEnv.fetchImpl) };
}

/** @throws when no server runs for the repository; the message tells Claude what to do. */
export async function connect(mcpEnv: McpEnvironment, repo?: string): Promise<Connection> {
  const repoPath = await resolveRepo(mcpEnv, repo);
  const conn = findServer(mcpEnv, repoPath);
  if (!conn) {
    throw new Error(`No promptgraph server is running for ${repoPath}. Call start_server to start one in the background, or run \`promptgraph\` in that repository.`);
  }
  return conn;
}

export interface StartedServer {
  connection: Connection;
  /** The server was already running; nothing was started. */
  alreadyRunning: boolean;
  logFile: string | null;
}

/**
 * Starts `promptgraph <repo> --no-open --port <port>` detached (it outlives the MCP server and the
 * Claude session), its output appended to `<PG_HOME>/logs/server-<repo-key>.log`, then waits for its
 * server-info record. Port 0 = any free port (discovery goes through the record, not the port).
 */
export async function startBackgroundServer(
  mcpEnv: McpEnvironment,
  repoPath: string,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<StartedServer> {
  const existing = findServer(mcpEnv, repoPath);
  if (existing) return { connection: existing, alreadyRunning: true, logFile: null };

  const logFile = backgroundServerLogPath(mcpEnv.paths, repoPath);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const fd = fs.openSync(logFile, "a", 0o600);
  let exited = null as { code: number | null } | null;
  try {
    const child = spawn(
      mcpEnv.serverCommand.command,
      [...mcpEnv.serverCommand.args, repoPath, "--no-open", "--port", String(opts.port ?? 0)],
      { cwd: repoPath, detached: true, stdio: ["ignore", fd, fd], env: childEnv({}, mcpEnv.env) },
    );
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
  while (Date.now() < deadline) {
    const conn = findServer(mcpEnv, repoPath);
    if (conn) return { connection: conn, alreadyRunning: false, logFile };
    if (exited) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const tail = tailLines(readFrom(logFile, logStart).trim(), 20);
  throw new Error(
    exited
      ? `promptgraph exited before it was ready (code ${exited.code}). Output:\n${tail}`
      : `promptgraph did not become ready in time. Output so far (${logFile}):\n${tail}`,
  );
}

function readFrom(file: string, offset: number): string {
  try {
    return fs.readFileSync(file).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}
