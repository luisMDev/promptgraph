import fs from "node:fs";

/** Whether a process with this pid exists (EPERM: it exists but belongs to another user). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Index of `starttime` in /proc/<pid>/stat counted from field 3 (the first field after `comm`). */
const START_TIME_FROM_STATE = 22 - 3;

/**
 * Start time of a process (`/proc/<pid>/stat` field 22, clock ticks since boot), or null when the
 * process does not exist or /proc is unreadable. Fields are read after the last `)`: field 2 (`comm`)
 * is the executable name in parentheses and may itself contain spaces and parentheses.
 */
export function processStartTime(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const value = Number(fields[START_TIME_FROM_STATE]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The process `pid` is alive and is the one that started at `start` (not a reused pid). */
export function isSameProcess(pid: number, start: number): boolean {
  return processStartTime(pid) === start;
}

/** USER_HZ: the unit of /proc's clock-tick fields, fixed at 100 by the Linux userland ABI. */
const CLOCK_TICKS_PER_SEC = 100;

/** Boot time in ms since the epoch (`btime` of /proc/stat), or null when unreadable. */
function bootTimeMs(): number | null {
  let stat: string;
  try {
    stat = fs.readFileSync("/proc/stat", "utf8");
  } catch {
    return null;
  }
  const match = /^btime\s+(\d+)$/m.exec(stat);
  return match ? Number(match[1]) * 1000 : null;
}

/**
 * Wall-clock start of a process in ms since the epoch (boot time + start ticks), or null when either is
 * unreadable. Second-granular (btime) and shifted by wall-clock adjustments since boot: compare it with
 * a slack.
 */
export function processStartedAtMs(pid: number): number | null {
  const ticks = processStartTime(pid);
  const boot = bootTimeMs();
  if (ticks === null || boot === null) return null;
  return boot + Math.round((ticks * 1000) / CLOCK_TICKS_PER_SEC);
}

/** Command line of a process (`/proc/<pid>/cmdline`, NUL-separated arguments joined with spaces), or null. */
export function processCmdline(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
}
