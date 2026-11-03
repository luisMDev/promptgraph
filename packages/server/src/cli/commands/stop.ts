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

/**
 * `promptgraph stop` (DESIGN §4.3): checks the record's identity (pid alive with the recorded start
 * time), sends SIGTERM and waits up to 30 s for that process to exit, printing a progress line every 5 s.
 * A stale record is removed and reported as not running (exit 1). Never signals a process whose start
 * time does not match the record. Works with a daemon of another version.
 */
export function runStop(_opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const file = daemonInfoPath(deps.paths);
    const record = readRecord(file);
    const info = readDaemonInfo(deps.paths);
    if (!info) {
      if (record || fs.existsSync(file)) {
        removeDaemonInfo(deps.paths, record?.pid);
        deps.stdout(`${NOT_RUNNING} (removed a stale record${record ? ` of pid ${record.pid}` : ""})`);
      } else deps.stdout(NOT_RUNNING);
      return 1;
    }
    const { pid, pidStart } = info;
    // Re-checked right before the signal: never signal a reused pid.
    if (!isSameProcess(pid, pidStart)) {
      removeDaemonInfo(deps.paths, pid);
      deps.stdout(NOT_RUNNING);
      return 1;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    deps.stdout(`Stopping promptgraph (pid ${pid}): running steps are interrupted and their runs stay resumable…`);
    const start = deps.now();
    let nextProgress = start + PROGRESS_EVERY_MS;
    while (isSameProcess(pid, pidStart)) {
      const now = deps.now();
      if (now - start >= STOP_TIMEOUT_MS) {
        deps.stderr(`error: promptgraph (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s; run promptgraph stop again, or check ${daemonLogPath(deps.paths)}`);
        return 1;
      }
      if (now >= nextProgress) {
        deps.stdout(`Still stopping (pid ${pid}, ${Math.round((now - start) / 1000)} s)…`);
        nextProgress += PROGRESS_EVERY_MS;
      }
      await deps.sleep(POLL_MS);
    }
    // A daemon that died without cleaning up leaves its record behind.
    removeDaemonInfo(deps.paths, pid);
    deps.stdout("Stopped.");
    return 0;
  });
}
