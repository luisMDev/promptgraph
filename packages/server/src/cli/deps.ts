import fs from "node:fs";
import path from "node:path";
import { REPO_ID_PATTERN, type RepoSummary } from "@promptgraph/shared";
import open from "open";
import { getPaths, SERVER_PACKAGE_DIR, type PgPaths } from "../config/paths.js";
import { VERSION } from "../config/version.js";
import { currentCliCommand, type DaemonConnection } from "../daemon/client.js";
import { resolveRepoRoot } from "../git/repo.js";
import { errorMessage } from "../util/text.js";

/**
 * What every CLI command gets injected (CONTRACTS §4), so tests can run a command without a child
 * process. Output goes through `stdout` / `stderr` one line at a time.
 */
export interface CliDeps {
  paths: PgPaths;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Opens a URL in the user's browser (the `open` package in production). */
  openBrowser: (url: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** argv that re-runs this CLI; ensureDaemon appends `daemon [--port p]`. */
  serverCommand: readonly string[];
  /** This CLI's version: a daemon of another version is refused (DESIGN §4.1 item 4). */
  version: string;
  fetchImpl?: typeof fetch;
  /**
   * Directory this CLI runs from when it is a bundled desktop runtime: `SERVER_PACKAGE_DIR/..` (DESIGN
   * §20.7). Read by `desktop install` and the runtime activation of `open`; tests inject a fixture.
   */
  runtimeRoot: string;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  return {
    paths: getPaths(env),
    env,
    cwd: process.cwd(),
    stdout: (line) => void process.stdout.write(`${line}\n`),
    stderr: (line) => void process.stderr.write(`${line}\n`),
    openBrowser: async (url) => {
      await open(url);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    serverCommand: currentCliCommand(),
    version: VERSION,
    runtimeRoot: path.resolve(SERVER_PACKAGE_DIR, ".."),
  };
}

/** `ls`, `stop`, `sessions`, `rm` without a daemon (exit 1). */
export const NOT_RUNNING = "promptgraph is not running";

/** A handled failure: its message is printed as `error: <message>` and the command exits with `code`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/**
 * Runs a command: a CliError, a version mismatch (DESIGN §4.1 item 4), an API error or anything else
 * thrown becomes `error: <message>` on stderr and exit 1 (or the CliError's code).
 */
export async function runCommand(deps: CliDeps, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    deps.stderr(`error: ${errorMessage(err)}`);
    return err instanceof CliError ? err.code : 1;
  }
}

/** Git top level of `dir`, as its realpath (the daemon's repository key). @throws CliError when it is not in a git repository. */
export async function repoRootOf(dir: string): Promise<string> {
  try {
    return fs.realpathSync(await resolveRepoRoot(dir));
  } catch {
    throw new CliError(`${dir} is not inside a git repository`);
  }
}

/**
 * A registered repository named by `target` (DESIGN §4.3): a repoId when it has the id shape and the
 * daemon knows it, else a directory, matched by the realpath of its git top level (or, for a directory
 * that no longer exists, by its absolute path). Null when neither matches.
 */
export async function findRegistered(repos: readonly RepoSummary[], target: string, cwd: string): Promise<RepoSummary | null> {
  if (REPO_ID_PATTERN.test(target)) {
    const byId = repos.find((r) => r.id === target);
    if (byId) return byId;
  }
  const abs = path.resolve(cwd, target);
  const candidates = new Set([abs]);
  try {
    candidates.add(fs.realpathSync(abs));
    candidates.add(fs.realpathSync(await resolveRepoRoot(abs)));
  } catch {
    // Missing or not a git repository any more: only the absolute path can match.
  }
  return repos.find((r) => candidates.has(r.path)) ?? null;
}

/** `http://127.0.0.1:<webPort>` with `--web-port`, else the daemon's origin. */
export function uiOrigin(conn: DaemonConnection, webPort: number | null): string {
  return webPort === null ? conn.origin : `http://127.0.0.1:${webPort}`;
}

/** Left-aligned columns separated by two spaces (the last column is not padded). */
export function formatTable(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

/** "3d 4h", "2h 5m", "4m 10s", "12s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** ISO-like local time without seconds: "2026-11-03 14:05". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
