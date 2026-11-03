import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { AppSettingsStore } from "../config/app-settings.js";
import { LegacyRepoLocks } from "../config/instance-lock.js";
import { getPaths, ptyLogPath, type PgPaths } from "../config/paths.js";
import { EventBus } from "../events/bus.js";
import { HookRouter } from "../hooks/hook-router.js";
import { Notifier } from "../notify/notifier.js";
import { PtyManager } from "../pty/pty-manager.js";
import { installPgHook } from "../runners/claude/pg-hook.js";
import { openDatabase, Store } from "../store/store.js";
import { checkPrereqs } from "../cli/prereqs.js";
import { writeToken } from "../config/token.js";
import { LoginCodes } from "./login-codes.js";
import { createRepoContext } from "./repo-context.js";
import { RepoRegistry } from "./registry.js";
import { Sessions } from "./sessions.js";

/**
 * Everything daemon-wide (DESIGN §4.1): one DB, bus, PTY manager, hook router and notifier shared by
 * every repository; each repository's engine, runners and graph store live in its RepoContext, built
 * by the registry.
 */
export interface DaemonContext {
  paths: PgPaths;
  /** The daemon's own environment: what every Claude, shell, git and gh child inherits (§4.1 item 5). */
  env: NodeJS.ProcessEnv;
  store: Store;
  bus: EventBus;
  settings: AppSettingsStore;
  ptys: PtyManager;
  hooks: HookRouter;
  /** Installed pg-hook script (bin/pg-hook). */
  pgHookPath: string;
  notifier: Notifier;
  /** Set once the HTTP server listens; read by the hooks endpoint and the localhost checks. */
  port: number;
  startedAt: number;
  /** Random per start, memory only: hook tokens derive from it, never from the token (DESIGN §7.1). */
  hookSecret: string;
  getToken(): string;
  setToken(token: string): void;
  /** Prerequisite warnings checked against the daemon's environment (computed once, on first use). */
  prereqWarnings(): Promise<string[]>;
  legacyLocks: LegacyRepoLocks;
  registry: RepoRegistry;
  /** One-time login codes (memory only, DESIGN §14). */
  loginCodes: LoginCodes;
  /** Browser and desktop sessions (`sessions` table, DESIGN §14). */
  sessions: Sessions;
}

export interface CreateDaemonContextOptions {
  token: string;
  /** Prerequisite warnings already checked by the caller; computed lazily from `env` otherwise. */
  warnings?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Composition root of the daemon: paths (home 0700) → Store (state.db, 0600) → EventBus →
 * AppSettingsStore → PtyManager (log resolver) → HookRouter → installPgHook → Notifier →
 * LegacyRepoLocks → RepoRegistry → LoginCodes → Sessions (expired sessions deleted; every session
 * deleted when the token is not the one they were issued under, see syncTokenFingerprint). Opens and
 * migrates the DB; does not listen and touches no repository.
 */
export function createDaemonContext(opts: CreateDaemonContextOptions): DaemonContext {
  const env = opts.env ?? process.env;
  const paths = getPaths(env);
  // Prompts, outputs, terminal logs and PR bodies live here: readable by the user only.
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.home, 0o700);
  const store = new Store(openDatabase(paths.stateDb));
  fs.chmodSync(paths.stateDb, 0o600);
  const bus = new EventBus();
  const settings = new AppSettingsStore(paths.settingsFile);
  const ptys = new PtyManager(bus, (ptyId) => resolvePtyLogPath(store, paths, ptyId));
  const hooks = new HookRouter();
  const pgHookPath = installPgHook(paths);
  const notifier = new Notifier({ bus, settings });
  const legacyLocks = new LegacyRepoLocks(paths);
  const sessions = new Sessions(store, bus);
  sessions.deleteExpired();
  syncTokenFingerprint(store, sessions, opts.token);
  let token = opts.token;
  let warnings: Promise<string[]> | null = opts.warnings ? Promise.resolve(opts.warnings) : null;
  const ctx: DaemonContext = {
    paths,
    env,
    store,
    bus,
    settings,
    ptys,
    hooks,
    pgHookPath,
    notifier,
    port: 0,
    startedAt: Date.now(),
    hookSecret: randomBytes(32).toString("base64url"),
    getToken: () => token,
    setToken: (t) => {
      token = t;
    },
    prereqWarnings: () =>
      (warnings ??= checkPrereqs(env).then(
        (r) => [...r.errors, ...r.warnings],
        () => [],
      )),
    legacyLocks,
    registry: new RepoRegistry({ store, bus, env, legacyLocks, createContext: (row) => createRepoContext(ctx, row) }),
    loginCodes: new LoginCodes(),
    sessions,
  };
  return ctx;
}

/**
 * `POST /api/daemon/token/rotate` (DESIGN §14): a new token in the file (atomic, 0600) and then in
 * memory, every session deleted, every outstanding login code dropped and every WebSocket closed with
 * 4401 (`token:rotated`). Hook tokens derive from the per-start hook secret, so live Claude sessions
 * keep reporting.
 */
export function rotateToken(ctx: DaemonContext): void {
  const token = randomBytes(32).toString("base64url");
  writeToken(ctx.paths, token);
  ctx.setToken(token);
  ctx.loginCodes.clear();
  ctx.sessions.revokeAll();
  ctx.store.setMeta(TOKEN_FINGERPRINT_KEY, tokenFingerprint(token));
  ctx.bus.emit("token:rotated", {});
}

/** `meta` key of the fingerprint of the token the stored sessions were issued under (DESIGN §14). */
export const TOKEN_FINGERPRINT_KEY = "token_fingerprint";

/** SHA-256 hex of a domain-separated token: identifies a token without storing it. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(`promptgraph-token-fingerprint:${token}`).digest("hex");
}

/**
 * At daemon start (DESIGN §14): when the token differs from the one recorded in `meta` (rotated
 * offline by `promptgraph token rotate`, replaced or deleted by hand, or no record yet), every session
 * is deleted before the first request, then the current fingerprint is recorded. Sessions issued under
 * an old token never outlive it. Returns how many sessions were deleted.
 */
export function syncTokenFingerprint(store: Store, sessions: Sessions, token: string): number {
  const fingerprint = tokenFingerprint(token);
  if (store.getMeta(TOKEN_FINGERPRINT_KEY) === fingerprint) return 0;
  const deleted = sessions.revokeAll();
  store.setMeta(TOKEN_FINGERPRINT_KEY, fingerprint);
  return deleted;
}

const PTY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Prefixes of auxiliary PTYs owned by a node run (CONTRACTS § PTY ids). */
const NODE_PTY_PREFIXES = ["setup-", "shell-"];

/**
 * Log file of a PTY that is not in memory (after a restart): node PTYs and their setup/shell PTYs via
 * the store; anything else (reopen PTYs) by looking for `<ptyId>.log` in the run dirs.
 */
export function resolvePtyLogPath(store: Store, paths: PgPaths, ptyId: string): string | null {
  if (!PTY_ID_PATTERN.test(ptyId)) return null;
  const owner =
    store.findNodeRunByPtyId(ptyId) ??
    NODE_PTY_PREFIXES.filter((p) => ptyId.startsWith(p))
      .map((p) => store.getNodeRun(ptyId.slice(p.length)))
      .find((nr) => nr !== undefined);
  if (owner) return ptyLogPath(paths, owner.runId, ptyId);
  let runIds: string[];
  try {
    runIds = fs.readdirSync(paths.runsDir);
  } catch {
    return null;
  }
  return runIds.map((runId) => ptyLogPath(paths, runId, ptyId)).find((file) => fs.existsSync(file)) ?? null;
}
