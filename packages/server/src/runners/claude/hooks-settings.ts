import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOOK_FOR_EVENT, HOOK_EVENTS } from "@promptgraph/shared";

export interface ClaudeHooksSettings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> }>>;
  permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: true };
}

export interface HooksSettingsOptions {
  /** promptgraph's home (PG_HOME): its secrets are denied to Claude's file tools (DESIGN §7.6). */
  pgHome: string;
}

/** pg-hook gives up after 2 s (curl -m 2); the timeout only guards against a stuck shell. */
const HOOK_TIMEOUT_SEC = 10;

/** POSIX single-quote quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Files under PG_HOME no agent may read or edit: the token, the Linear API key (§24), the state DB (+ WAL/SHM), the run dirs (hook
 * header files), the discovery records of pre-M7 per-repo servers (`servers/*.json` carry their live API
 * token) and the logs (pre-M7 detached servers printed a token URL to `logs/server-<repo-key>.log`; the
 * daemon's own log holds no credential, but old logs may remain).
 */
const DENIED_UNDER_HOME = ["token", "linear-key", "state.db*", "runs/**", "servers/**", "logs/**"];

/** The absolute rule path (`//<path without its leading slash>`) of a directory. */
const rulePath = (dir: string) => `//${dir.replace(/^\/+/, "").replace(/\/+$/, "")}`;

/**
 * `permissions.deny` rules for promptgraph's own secrets (DESIGN §7.6): `Read` of PG_HOME itself (a
 * recursive grep or find naming it, `..` from a lane worktree included), and `Read` and `Edit` of each
 * secret path, as absolute rule paths (`//<home without its leading slash>/…`, Claude Code's
 * absolute-path form). Written for PG_HOME as given and for its realpath when it is a symlink, so a read
 * by either spelling matches with any Claude Code version.
 */
export function secretDenyRules(pgHome: string): string[] {
  const homes = [path.resolve(pgHome)];
  try {
    const real = fs.realpathSync(pgHome);
    if (real !== homes[0]) homes.push(real);
  } catch {
    // Not created yet: only the given path can be read.
  }
  return homes.flatMap((home) => {
    const root = rulePath(home);
    return [`Read(${root})`, ...DENIED_UNDER_HOME.flatMap((rel) => [`Read(${root}/${rel})`, `Edit(${root}/${rel})`])];
  });
}

/**
 * §7.2: one entry per HookEvent (CLAUDE_HOOK_FOR_EVENT), command = `<abs pg-hook path> <event>` (path
 * shell-quoted), plus the §7.6 permissions: deny rules for PG_HOME's secrets, and
 * `blockReadsOutsideWorkingDirectories`, without which Claude Code's built-in read-only Bash commands
 * (`grep`, `find`, `cat`, …) read any path without a prompt and a command that names no file (`grep -r x
 * .` from a parent) escapes the deny rules. With it, file tools refuse paths outside the session's working
 * directory (the lane worktree) and recognised reading commands prompt.
 */
export function buildHooksSettings(pgHookPath: string, opts: HooksSettingsOptions): ClaudeHooksSettings {
  const hooks: ClaudeHooksSettings["hooks"] = {};
  for (const event of HOOK_EVENTS) {
    hooks[CLAUDE_HOOK_FOR_EVENT[event]] = [
      { hooks: [{ type: "command", command: `${shellQuote(pgHookPath)} ${event}`, timeout: HOOK_TIMEOUT_SEC }] },
    ];
  }
  return { hooks, permissions: { deny: secretDenyRules(opts.pgHome), blockReadsOutsideWorkingDirectories: true } };
}

/** Writes hooks.json for a run (idempotent) and returns its path. */
export function writeHooksSettings(file: string, pgHookPath: string, opts: HooksSettingsOptions): string {
  const content = `${JSON.stringify(buildHooksSettings(pgHookPath, opts), null, 2)}\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return file;
}
