import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PgPaths } from "../config/paths.js";

/**
 * `<PG_HOME>/linear-key` (DESIGN §11.3, §24): the user's Linear personal API key, mode 0600. Only the daemon reads
 * it: no route returns it, it is never logged or put in a child's environment, and the `--settings` file of every
 * Claude session denies Claude's file tools access to it (§7.6).
 */
export function linearKeyPath(paths: PgPaths): string {
  return path.join(paths.home, "linear-key");
}

/** The saved key, or null when there is none (missing or empty file). The mode is re-asserted to 0600. */
export function readLinearKey(paths: PgPaths): string | null {
  const file = linearKeyPath(paths);
  let key: string;
  try {
    key = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  fs.chmodSync(file, 0o600);
  return key || null;
}

/** Saves the key atomically (temp file 0600 + rename). */
export function writeLinearKey(paths: PgPaths, key: string): void {
  const file = linearKeyPath(paths);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${key}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
}

export function deleteLinearKey(paths: PgPaths): void {
  fs.rmSync(linearKeyPath(paths), { force: true });
}
