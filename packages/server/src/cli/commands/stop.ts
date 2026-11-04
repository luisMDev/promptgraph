import fs from "node:fs";
import { DaemonInfoSchema, type DaemonInfo } from "@promptgraph/shared";
import { daemonInfoPath, daemonLogPath, readDaemonInfo, removeDaemonInfo } from "../../config/daemon-info.js";
import { isSameProcess } from "../../util/process.js";
import type { CliOptions } from "../args.js";
import { NOT_RUNNING, runCommand, type CliDeps } from "../deps.js";

/** How long `stop` waits for the daemon to exit (its engines give Claude PTYs ≤5 s each, concurrently). */
export const STOP_TIMEOUT_MS = 30_000;
const PROGRESS_EVERY_MS = 5_000;
const POLL_MS = 100;

function readRecord(file: string): DaemonInfo | null {
  try {
    const parsed = DaemonInfoSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What stopDaemon did. */
export type StopOutcome = "stopped" | "not-running" | "timeout";

/** Progress callbacks of stopDaemon (runStop turns them into its lines; the handover stays quiet on stdout). */
export interface StopReporter {
  /** No live daemon; `removed`: a stale record was deleted (`pid`: its pid, when it parsed). */
  notRunning?(stale: { removed: boolean; pid?: number }): void;
  signalled?(pid: number): void;
  progress?(pid: number, seconds: number): void;
  timeout?(pid: number): void;
}

/**
 * Stops the recorded daemon (DESIGN §4.3 `stop`): checks the record's identity (pid alive with the
 * recorded start time), sends SIGTERM and waits up to STOP_TIMEOUT_MS for that process to exit. A stale
 * record is removed (`not-running`). Never signals a process whose start time does not match the
 * record. Works with a daemon of another version. Shared by `stop` and `open --on-version-mismatch`.
 */
export async function stopDaemon(deps: CliDeps, report: StopReporter = {}): Promise<StopOutcome> {
  const file = daemonInfoPath(deps.paths);
  const record = readRecord(file);
  const info = readDaemonInfo(deps.paths);
  if (!info) {
    const removed = Boolean(record) || fs.existsSync(file);
    if (removed) removeDaemonInfo(deps.paths, record?.pid);
    report.notRunning?.({ removed, pid: record?.pid });
    return "not-running";
  }
  const { pid, pidStart } = info;
  // Re-checked right before the signal: never signal a reused pid.
  if (!isSameProcess(pid, pidStart)) {
    removeDaemonInfo(deps.paths, pid);
    report.notRunning?.({ removed: false });
    return "not-running";
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  report.signalled?.(pid);
  const start = deps.now();
  let nextProgress = start + PROGRESS_EVERY_MS;
  while (isSameProcess(pid, pidStart)) {
    const now = deps.now();
    if (now - start >= STOP_TIMEOUT_MS) {
      report.timeout?.(pid);
      return "timeout";
    }
    if (now >= nextProgress) {
      report.progress?.(pid, Math.round((now - start) / 1000));
      nextProgress += PROGRESS_EVERY_MS;
    }
    await deps.sleep(POLL_MS);
  }
  // A daemon that died without cleaning up leaves its record behind.
  removeDaemonInfo(deps.paths, pid);
  return "stopped";
}

/**
 * `promptgraph stop` (DESIGN §4.3): stopDaemon, printing a progress line every 5 s. A stale record is
 * removed and reported as not running (exit 1); a timeout exits 1.
 */
export function runStop(_opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const outcome = await stopDaemon(deps, {
      notRunning: ({ removed, pid }) => deps.stdout(removed ? `${NOT_RUNNING} (removed a stale record${pid !== undefined ? ` of pid ${pid}` : ""})` : NOT_RUNNING),
      signalled: (pid) => deps.stdout(`Stopping promptgraph (pid ${pid}): running steps are interrupted and their runs stay resumable…`),
      progress: (pid, seconds) => deps.stdout(`Still stopping (pid ${pid}, ${seconds} s)…`),
      timeout: (pid) =>
        deps.stderr(`error: promptgraph (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s; run promptgraph stop again, or check ${daemonLogPath(deps.paths)}`),
    });
    if (outcome !== "stopped") return 1;
    deps.stdout("Stopped.");
    return 0;
  });
}
