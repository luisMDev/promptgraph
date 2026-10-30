import fs from "node:fs";
import path from "node:path";
import { claudeConfigFile } from "../../config/paths.js";

/** Matches Claude Code's workspace trust dialog in ANSI-stripped, whitespace-removed PTY output (SPIKE A5). */
export const TRUST_DIALOG_PATTERN = /Doyoutrustthefilesinthisfolder|Itrustthisfolder/i;

/** Writes to the same config file are chained so concurrent node starts never lose an update. */
let queue: Promise<void> = Promise.resolve();

/**
 * SPIKE A5: atomic read-modify-write of `projects["<dir>"].hasTrustDialogAccepted = true` in
 * claudeConfigFile(env). Serialised within the process; tolerant to a missing file (creates it).
 * Must never be pointed at the real ~/.claude.json in tests (set CLAUDE_CONFIG_DIR).
 */
export function preTrustDirectory(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = claudeConfigFile(env);
  const next = queue.then(() => trustInFile(file, dir));
  queue = next.catch(() => undefined);
  return next;
}

async function trustInFile(file: string, dir: string): Promise<void> {
  const dirs = new Set([path.resolve(dir)]);
  try {
    dirs.add(await fs.promises.realpath(dir));
  } catch {
    // Not created yet: the resolved path is all we can trust.
  }
  let raw: string | null = null;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // An unparsable config is left untouched: overwriting it would destroy the user's Claude Code state.
  const config = (raw && raw.trim() ? JSON.parse(raw) : {}) as { projects?: Record<string, Record<string, unknown>> };
  const projects = (config.projects ??= {});
  let changed = false;
  for (const d of dirs) {
    if (projects[d]?.hasTrustDialogAccepted === true) continue;
    projects[d] = { ...projects[d], hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return;
  // Write through a symlinked config instead of replacing the link.
  const target = raw === null ? file : await fs.promises.realpath(file);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const mode = raw === null ? 0o600 : (await fs.promises.stat(target)).mode & 0o777;
  const tmp = `${target}.pg-${process.pid}-${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(config, null, 2), { mode });
  await fs.promises.rename(tmp, target);
}
