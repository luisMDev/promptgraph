import { execFile } from "node:child_process";
import type { BillingMode, ClaudeAuthInfo } from "@promptgraph/shared";
import { errorMessage } from "../util/text.js";
import { childEnv, claudeBin } from "./child-env.js";

/**
 * Billing mode of the Claude sessions promptgraph starts (DESIGN §23.1), from `claude auth status --json`: the
 * documented CLI, run with the daemon's environment in the repository's main checkout (project settings may set
 * `apiKeyHelper` or `env`). promptgraph never reads Claude Code's credentials itself.
 */

const STATUS_TIMEOUT_MS = 10_000;
/** How long a check is reused; `refresh` forces a new one. */
export const CLAUDE_AUTH_TTL_MS = 5 * 60_000;
/** A `refresh` within this time of the last check reuses it (rapid "Check again" clicks spawn one claude). */
const MIN_REFRESH_INTERVAL_MS = 1000;
/** Variables that select an API key; removed for the second check (is a claude.ai login stored as well?). */
const API_KEY_VARS = ["ANTHROPIC_API_KEY"] as const;

/** The fields promptgraph reads from `claude auth status --json` (Claude Code 2.1.319). Account ids are ignored. */
export interface RawAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  apiKeySource?: string;
  subscriptionType?: string;
  planTier?: string;
}

/** Runs `claude auth status --json`; resolves the parsed JSON (also on exit code 1 = signed out) or rejects. */
export type AuthStatusRunner = (env: NodeJS.ProcessEnv, cwd: string) => Promise<RawAuthStatus>;

export const runAuthStatus: AuthStatusRunner = (env, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      claudeBin(env),
      ["auth", "status", "--json"],
      { env: childEnv({}, env), cwd, timeout: STATUS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("The claude command was not found on PATH"));
        try {
          resolve(JSON.parse(stdout) as RawAuthStatus);
        } catch {
          reject(err ?? new Error("claude auth status printed no JSON"));
        }
      },
    );
  });

/**
 * Billing mode of an auth status. `oauth_token` is either `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, a
 * subscription) or `ANTHROPIC_AUTH_TOKEN` (a bearer token, usually a gateway); the latter takes precedence.
 */
export function billingModeOf(raw: RawAuthStatus, env: NodeJS.ProcessEnv): BillingMode {
  if (raw.loggedIn === false) return "none";
  switch (raw.authMethod) {
    case "claude.ai":
      return "subscription";
    case "api_key":
    case "api_key_helper":
      return "api";
    case "third_party":
      return "cloud";
    case "oauth_token":
      return env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_AUTH_TOKEN ? "subscription" : "unknown";
    case "none":
      return "none";
    default:
      return "unknown";
  }
}

export function authInfoOf(raw: RawAuthStatus, env: NodeJS.ProcessEnv, now: number, apiKeyOverridesLogin = false): ClaudeAuthInfo {
  const billingMode = billingModeOf(raw, env);
  return {
    billingMode,
    authMethod: raw.authMethod ?? "none",
    apiProvider: raw.apiProvider ?? null,
    apiKeySource: raw.apiKeySource ?? null,
    plan: billingMode === "subscription" ? (raw.subscriptionType ?? null) : null,
    planTier: billingMode === "subscription" ? (raw.planTier ?? null) : null,
    apiKeyOverridesLogin,
    error: null,
    checkedAt: now,
  };
}

/** Checks the auth status in `cwd`; with an API key from the environment, also whether a claude.ai login is stored. */
export async function checkClaudeAuth(env: NodeJS.ProcessEnv, cwd: string, run: AuthStatusRunner = runAuthStatus, now: () => number = Date.now): Promise<ClaudeAuthInfo> {
  let raw: RawAuthStatus;
  try {
    raw = await run(env, cwd);
  } catch (err) {
    return { ...authInfoOf({ authMethod: "none" }, env, now()), billingMode: "unknown", error: errorMessage(err) };
  }
  let overrides = false;
  if (raw.authMethod === "api_key" && raw.apiKeySource && (API_KEY_VARS as readonly string[]).includes(raw.apiKeySource)) {
    const withoutKey = { ...env };
    for (const name of API_KEY_VARS) delete withoutKey[name];
    try {
      overrides = (await run(withoutKey, cwd)).authMethod === "claude.ai";
    } catch {
      // Best effort: the main result stands.
    }
  }
  return authInfoOf(raw, env, now(), overrides);
}

interface CacheEntry {
  info: ClaudeAuthInfo | null;
  pending: Promise<ClaudeAuthInfo> | null;
}

/** Per-repository cache of checkClaudeAuth (daemon-wide; keyed by the repository path). */
export class ClaudeAuthProbe {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly opts: { run?: AuthStatusRunner; now?: () => number; ttlMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * The cached check if fresh, else a new one; concurrent calls share one check. `refresh` skips the cache unless the
   * last check is under a second old.
   */
  get(repoPath: string, opts: { refresh?: boolean } = {}): Promise<ClaudeAuthInfo> {
    const entry = this.cache.get(repoPath) ?? { info: null, pending: null };
    this.cache.set(repoPath, entry);
    if (entry.pending) return entry.pending;
    const ttl = this.opts.ttlMs ?? CLAUDE_AUTH_TTL_MS;
    const age = entry.info ? this.now() - entry.info.checkedAt : Infinity;
    if (age < (opts.refresh ? MIN_REFRESH_INTERVAL_MS : ttl)) return Promise.resolve(entry.info!);
    const pending = checkClaudeAuth(this.env, repoPath, this.opts.run, this.now).then((info) => {
      entry.info = info;
      entry.pending = null;
      return info;
    });
    entry.pending = pending;
    return pending;
  }

  /** The last check, fresh or not, without starting one. */
  peek(repoPath: string): ClaudeAuthInfo | null {
    return this.cache.get(repoPath)?.info ?? null;
  }

  forget(repoPath: string): void {
    this.cache.delete(repoPath);
  }
}
