import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DaemonInfoSchema, ServerInfoSchema, type DaemonInfo, type ServerInfo } from "@promptgraph/shared";
import { isProcessAlive, isSameProcess, processCmdline, processStartedAtMs } from "../util/process.js";
import type { PgPaths } from "./paths.js";

/** Rotation threshold of the detached daemon's log (DESIGN §4.1 item 9). */
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** `<PG_HOME>/daemon.json` (DESIGN §11.3). */
export function daemonInfoPath(paths: PgPaths): string {
  return path.join(paths.home, "daemon.json");
}

/** Output of a detached daemon, appended (`<PG_HOME>/logs/daemon.log`). */
export function daemonLogPath(paths: PgPaths): string {
  return path.join(paths.home, "logs", "daemon.log");
}

/** `<PG_HOME>/port`: the last port the daemon bound (the sticky port, DESIGN §4.1 item 2). */
export function portFilePath(paths: PgPaths): string {
  return path.join(paths.home, "port");
}

/** Pre-M7 per-repository discovery records (DESIGN §4.4). */
function legacyServersDir(paths: PgPaths): string {
  return path.join(paths.home, "servers");
}

/** Atomic write (temp + rename), mode 0600. */
function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Written once the daemon is ready (atomic, 0600). */
export function writeDaemonInfo(paths: PgPaths, info: DaemonInfo): void {
  writeFileAtomic(daemonInfoPath(paths), `${JSON.stringify(DaemonInfoSchema.parse(info), null, 2)}\n`);
}

/** Removes the record only when it belongs to `pid` (or does not parse): a newer daemon may own it. */
export function removeDaemonInfo(paths: PgPaths, pid: number = process.pid): void {
  const file = daemonInfoPath(paths);
  const parsed = DaemonInfoSchema.safeParse(readJson(file));
  if (!parsed.success || parsed.data.pid === pid) fs.rmSync(file, { force: true });
}

/**
 * The record of a live daemon, or null when it is missing, does not parse, its pid is dead, or that pid
 * started at another time than `pidStart` (a reused pid). The hello proof is checked by the client.
 */
export function readDaemonInfo(paths: PgPaths): DaemonInfo | null {
  const parsed = DaemonInfoSchema.safeParse(readJson(daemonInfoPath(paths)));
  if (!parsed.success) return null;
  return isSameProcess(parsed.data.pid, parsed.data.pidStart) ? parsed.data : null;
}

/** Renames `daemon.log` to `daemon.log.1` (replacing it) when it is larger than `maxBytes`. Returns whether it rotated. */
export function rotateDaemonLog(paths: PgPaths, maxBytes: number = DAEMON_LOG_MAX_BYTES): boolean {
  const file = daemonLogPath(paths);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  fs.renameSync(file, `${file}.1`);
  return true;
}

/** The sticky port, or null when the file is missing or invalid. */
export function readStickyPort(paths: PgPaths): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(portFilePath(paths), "utf8").trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

export function writeStickyPort(paths: PgPaths, port: number): void {
  writeFileAtomic(portFilePath(paths), `${port}\n`);
}

function legacyRecords(paths: PgPaths): Array<{ file: string; info: ServerInfo }> {
  const dir = legacyServersDir(paths);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      const file = path.join(dir, n);
      const parsed = ServerInfoSchema.safeParse(readJson(file));
      return parsed.success ? { file, info: parsed.data } : null;
    })
    .filter((r): r is { file: string; info: ServerInfo } => r !== null);
}

/**
 * Slack for comparing a process's start with a record's `startedAt`: btime is second-granular and
 * shifts with wall-clock adjustments since boot.
 */
const LEGACY_START_SLACK_MS = 60_000;

/**
 * Whether a pre-M7 record names a live server. ServerInfo has no pidStart, so a record left by a crashed
 * server whose pid was reused (typically after a reboot) is told apart by two signals: the process
 * started after the record was written (`startedAt` + slack) and its command line does not mention
 * promptgraph. Either signal alone keeps the record live, and so does an unreadable /proc: wrongly
 * calling a live server stale would let the daemon interrupt its runs.
 */
export function isLegacyServerLive(info: ServerInfo): boolean {
  if (!isProcessAlive(info.pid)) return false;
  const started = processStartedAtMs(info.pid);
  if (started === null || started <= info.startedAt + LEGACY_START_SLACK_MS) return true;
  const cmdline = processCmdline(info.pid);
  return cmdline === null || /promptgraph/i.test(cmdline);
}

/** Live pre-M7 per-repository servers (isLegacyServerLive): the daemon refuses to start while any runs. */
export function findLegacyServers(paths: PgPaths): ServerInfo[] {
  return legacyRecords(paths)
    .filter((r) => isLegacyServerLive(r.info))
    .map((r) => r.info);
}

/** Deletes the `servers/*.json` records that do not name a live server (nothing else). Returns the removed files. */
export function removeStaleLegacy(paths: PgPaths): string[] {
  const removed: string[] = [];
  for (const r of legacyRecords(paths)) {
    if (isLegacyServerLive(r.info)) continue;
    fs.rmSync(r.file, { force: true });
    removed.push(r.file);
  }
  return removed;
}
