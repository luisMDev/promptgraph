import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DesktopPrefsSchema, type DesktopPrefs, type ShimDecision } from "@promptgraph/shared";
import { desktopPaths } from "./paths.js";

/** The desktop prefs (DESIGN §20.8); a missing or invalid file reads as `{v: 1}`. */
export function readPrefs(file: string): DesktopPrefs {
  try {
    const parsed = DesktopPrefsSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or not JSON.
  }
  return { v: 1 };
}

/** Writes the prefs atomically (temp file + rename), mode 0600, in a parent directory created 0700. */
export function writePrefs(file: string, prefs: DesktopPrefs): void {
  const value = DesktopPrefsSchema.parse(prefs);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Records the user's answer to the shim question; the PATH-check fields of an earlier decision are kept. */
export function recordShimDecision(env: NodeJS.ProcessEnv, decision: ShimDecision, now: number = Date.now()): DesktopPrefs {
  const file = desktopPaths(env).prefsFile;
  const prefs = readPrefs(file);
  const next: DesktopPrefs = { ...prefs, shim: { ...prefs.shim, decision, decidedAt: now } };
  writePrefs(file, next);
  return next;
}

/**
 * Records the outcome of a PATH check (`pathOk`) and, when given, the version that showed the PATH
 * warning. No-op without a recorded decision (the check only follows an install).
 */
export function recordPathCheck(env: NodeJS.ProcessEnv, ok: boolean, warnedVersion?: string): DesktopPrefs {
  const file = desktopPaths(env).prefsFile;
  const prefs = readPrefs(file);
  if (!prefs.shim) return prefs;
  const next: DesktopPrefs = { ...prefs, shim: { ...prefs.shim, pathOk: ok, ...(warnedVersion !== undefined ? { warnedVersion } : {}) } };
  writePrefs(file, next);
  return next;
}
