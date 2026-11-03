/** Claude binary; tests point it at test/fixtures/fake-claude. */
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PG_CLAUDE_BIN || "claude";
}

/** GitHub CLI binary (pr nodes); tests point it at test/fixtures/fake-gh. */
export function ghBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PG_GH_BIN || "gh";
}

/**
 * Variables that make a child `claude` behave as a nested/hermetic session (SPIKE): it would not persist
 * transcripts or would refuse to start. Stripped from every child process env.
 */
const CLAUDE_NESTING_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_TEE_SDK_STDOUT",
  "CLAUDE_CODE_SYNC_SESSION_REFS",
]);
const STRIPPED_PATTERN = /HERMETIC/;

/** Whether `name` makes a child `claude` a nested/hermetic session (also stripped from a detached daemon's env). */
export function isClaudeNestingVar(name: string): boolean {
  return CLAUDE_NESTING_VARS.has(name) || STRIPPED_PATTERN.test(name);
}

/** promptgraph's own variables passed to hooks (§7.1). */
export interface PgHookEnv {
  PG_PORT: string;
  /** File with the `Authorization` header carrying the node run's hook token (never the session token). */
  PG_HOOK_HEADER_FILE: string;
  PG_NODE_RUN_ID: string;
}

/**
 * The PgHookEnv keys. They belong to one node run: inherited from a Claude session promptgraph spawned
 * (start_server called from inside a run), they would point every child at that run's stale hook
 * endpoint and header file. Stripped from a detached daemon's env and from every child env; a Claude
 * runner passes its own through `extra`.
 */
export const PG_HOOK_ENV_VARS: ReadonlySet<string> = new Set<keyof PgHookEnv>(["PG_PORT", "PG_HOOK_HEADER_FILE", "PG_NODE_RUN_ID"]);

/** Child env = parent env − nested-session vars − PG_HOME − PG_HOOK_ENV_VARS + TERM + `extra`. */
export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    // promptgraph's home holds the token and the DB: children (Claude, shell nodes) are not told where it is (DESIGN §7.6).
    if (v === undefined || k === "PG_HOME" || PG_HOOK_ENV_VARS.has(k) || isClaudeNestingVar(k)) continue;
    env[k] = v;
  }
  return { ...env, TERM: "xterm-256color", ...extra };
}
