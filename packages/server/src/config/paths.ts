import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of promptgraph's own state. `PG_HOME` overrides `~/.promptgraph` (tests). Under vitest (`VITEST`
 * is set, and inherited by every process a test spawns) a missing PG_HOME is an error instead of a
 * fallback, so a test can never read or migrate the user's real state.
 */
export function pgHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PG_HOME) return path.resolve(env.PG_HOME);
  if (env.VITEST ?? process.env.VITEST) throw new Error("PG_HOME must be set under vitest (refusing to fall back to ~/.promptgraph)");
  return path.join(os.homedir(), ".promptgraph");
}

export interface PgPaths {
  home: string;
  /** SQLite database (§11.2). */
  stateDb: string;
  /** App settings JSON (AppSettings). */
  settingsFile: string;
  /** Per-run dirs: hooks.json + terminal logs. */
  runsDir: string;
  /** Worktrees root: <worktreesDir>/<repo-name>/<run-id>/<lane-id> (§9.1). */
  worktreesDir: string;
  /** Installed helper scripts (pg-hook). */
  binDir: string;
  /** Short-lived private files (voice dictation WAVs, §22.5). */
  tmpDir: string;
  /** Whisper models the user drops in (voice dictation auto-detection, §22.3). */
  modelsDir: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): PgPaths {
  const home = pgHome(env);
  return {
    home,
    stateDb: path.join(home, "state.db"),
    settingsFile: path.join(home, "settings.json"),
    runsDir: path.join(home, "runs"),
    worktreesDir: path.join(home, "worktrees"),
    binDir: path.join(home, "bin"),
    tmpDir: path.join(home, "tmp"),
    modelsDir: path.join(home, "models"),
  };
}

export function runDir(paths: PgPaths, runId: string): string {
  return path.join(paths.runsDir, runId);
}

/** Terminal log of a PTY after exit (§7.3). For node PTYs ptyId === nodeRunId. */
export function ptyLogPath(paths: PgPaths, runId: string, ptyId: string): string {
  return path.join(runDir(paths, runId), `${ptyId}.log`);
}

/** hooks.json generated once per run (§7.2). */
export function hooksSettingsPath(paths: PgPaths, runId: string): string {
  return path.join(runDir(paths, runId), "hooks.json");
}

/**
 * Whether the realpath `p` is the worktrees root or inside it (DESIGN §4.2): a lane worktree is never a
 * repository of its own. Compares against the root as configured and its realpath (PG_HOME may be a link).
 */
export function isInWorktreesDir(paths: PgPaths, p: string): boolean {
  const roots = new Set([path.resolve(paths.worktreesDir)]);
  try {
    roots.add(fs.realpathSync(paths.worktreesDir));
  } catch {
    // Not created yet: nothing can be inside it but the configured path.
  }
  return [...roots].some((root) => p === root || p.startsWith(root + path.sep));
}

export function worktreePath(paths: PgPaths, repoName: string, runId: string, laneId: string): string {
  return path.join(paths.worktreesDir, repoName, runId, laneId);
}

/** Graph files live in the target repo. */
export function graphsDir(repoPath: string): string {
  return path.join(repoPath, ".promptgraph", "graphs");
}

/** Claude Code's global config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` (SPIKE A5). */
export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json` (read-only). */
export function claudeUserSettingsFile(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), "settings.json") : path.join(homeDir, ".claude", "settings.json");
}

/** packages/server root (works from src/ via tsx and from dist/). */
export const SERVER_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Shipped pg-hook script; installed into binDir at startup. */
export const PG_HOOK_SOURCE = path.join(SERVER_PACKAGE_DIR, "assets", "pg-hook");

/** Built web assets served by the server. `PG_WEB_DIST` overrides. */
export function webDistDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PG_WEB_DIST ? path.resolve(env.PG_WEB_DIST) : path.resolve(SERVER_PACKAGE_DIR, "..", "web", "dist");
}
