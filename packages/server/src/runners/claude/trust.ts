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

type ClaudeConfig = { projects?: Record<string, Record<string, unknown>> };

function readConfig(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/** The config with every dir trusted, or null when nothing changes. Throws on an unparsable config. */
function withTrust(raw: string | null, dirs: ReadonlySet<string>): string | null {
  // An unparsable config is left untouched: overwriting it would destroy the user's Claude Code state.
  const config = (raw && raw.trim() ? JSON.parse(raw) : {}) as ClaudeConfig;
  const projects = (config.projects ??= {});
  let changed = false;
  for (const d of dirs) {
    if (projects[d]?.hasTrustDialogAccepted === true) continue;
    projects[d] = { ...projects[d], hasTrustDialogAccepted: true };
    changed = true;
  }
  return changed ? JSON.stringify(config, null, 2) : null;
}

/**
 * Running Claude processes write the same file, so the read-merge-write is synchronous (no other
 * work of this process interleaves) and the source is re-read right before the rename: if it changed
 * meanwhile the merge is redone instead of overwriting the other writer's update.
 */
async function trustInFile(file: string, dir: string): Promise<void> {
  const dirs = new Set([path.resolve(dir)]);
  try {
    dirs.add(await fs.promises.realpath(dir));
  } catch {
    // Not created yet: the resolved path is all we can trust.
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = readConfig(file);
    const next = withTrust(raw, dirs);
    if (next === null) return;
    // Write through a symlinked config instead of replacing the link.
    const target = raw === null ? file : fs.realpathSync(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = raw === null ? 0o600 : fs.statSync(target).mode & 0o777;
    const tmp = `${target}.pg-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, next, { mode });
    if (readConfig(file) === raw) {
      fs.renameSync(tmp, target);
      return;
    }
    fs.rmSync(tmp, { force: true });
  }
  throw new Error(`Could not update ${file}: it keeps changing`);
}
