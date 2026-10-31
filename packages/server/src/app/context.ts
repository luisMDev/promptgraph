import fs from "node:fs";
import path from "node:path";
import { AppSettingsStore } from "../config/app-settings.js";
import { getPaths, ptyLogPath, type PgPaths } from "../config/paths.js";
import { SUPPORTED_PHASE } from "../config/version.js";
import { Engine } from "../engine/engine.js";
import { EventBus } from "../events/bus.js";
import { GraphStore } from "../graphs/graph-store.js";
import { HookRouter } from "../hooks/hook-router.js";
import { Notifier } from "../notify/notifier.js";
import { PtyManager } from "../pty/pty-manager.js";
import { ClaudeRunner } from "../runners/claude/claude-runner.js";
import { installPgHook } from "../runners/claude/pg-hook.js";
import { createRunnerRegistry } from "../runners/registry.js";
import { openDatabase, Store } from "../store/store.js";
import { LaneManager, type RepoRef } from "../workspace/lane-manager.js";

/** Everything the HTTP/WS layers need. Built once by createAppContext (composition root). */
export interface AppContext {
  repo: RepoRef;
  paths: PgPaths;
  /** Random per-start session token (§14). */
  token: string;
  /** Prerequisite warnings shown in the UI (RepoInfoResponse.warnings). */
  warnings: string[];
  bus: EventBus;
  store: Store;
  graphs: GraphStore;
  settings: AppSettingsStore;
  ptys: PtyManager;
  hooks: HookRouter;
  lanes: LaneManager;
  engine: Engine;
  notifier: Notifier;
  /** Set by the server once listening; read by ClaudeRunner for PG_PORT. */
  port: number;
  /** Base env of the server (locates the user's Claude config for GET /api/commands). */
  env: NodeJS.ProcessEnv;
}

export interface CreateAppContextOptions {
  repoPath: string;
  token: string;
  warnings?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Wires every module: paths → DB (openDatabase + Store) → EventBus → GraphStore → AppSettingsStore →
 * PtyManager (log resolver via store.findNodeRunByPtyId / reopen registry) → HookRouter → installPgHook →
 * LaneManager → ClaudeRunner → createRunnerRegistry → Engine → Notifier. Does not start listening.
 */
export async function createAppContext(opts: CreateAppContextOptions): Promise<AppContext> {
  const env = opts.env ?? process.env;
  const paths = getPaths(env);
  // Prompts, outputs, terminal logs and PR bodies live here: readable by the user only.
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.home, 0o700);
  const store = new Store(openDatabase(paths.stateDb));
  fs.chmodSync(paths.stateDb, 0o600);
  const bus = new EventBus();
  const repo: RepoRef = { path: opts.repoPath, name: path.basename(opts.repoPath) };
  const graphs = new GraphStore(repo.path, bus);
  const settings = new AppSettingsStore(paths.settingsFile);
  const ptys = new PtyManager(bus, (ptyId) => resolvePtyLogPath(store, paths, ptyId));
  const hooks = new HookRouter();
  const pgHookPath = installPgHook(paths);
  const lanes = new LaneManager({ store, bus, paths, repo });
  // `ctx.port` is only read when a node starts, i.e. after the server is listening.
  const claude = new ClaudeRunner({ ptys, hooks, paths, pgHookPath, endpoint: () => ({ port: ctx.port, token: opts.token }), env });
  const runners = createRunnerRegistry({ claude, ptys, lanes, paths, env });
  const engine = new Engine({ store, graphs, lanes, ptys, runners, claude, bus, paths, repo, phase: SUPPORTED_PHASE, env });
  ptys.onUserInput((ptyId) => engine.handleUserInput(ptyId));
  const notifier = new Notifier({ bus, settings });
  const ctx: AppContext = {
    repo,
    paths,
    token: opts.token,
    warnings: opts.warnings ?? [],
    bus,
    store,
    graphs,
    settings,
    ptys,
    hooks,
    lanes,
    engine,
    notifier,
    port: 0,
    env,
  };
  return ctx;
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
