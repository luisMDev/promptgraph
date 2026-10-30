import type { AppSettingsStore } from "../config/app-settings.js";
import type { PgPaths } from "../config/paths.js";
import type { Engine } from "../engine/engine.js";
import type { EventBus } from "../events/bus.js";
import type { GraphStore } from "../graphs/graph-store.js";
import type { HookRouter } from "../hooks/hook-router.js";
import type { Notifier } from "../notify/notifier.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { Store } from "../store/store.js";
import type { LaneManager, RepoRef } from "../workspace/lane-manager.js";

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
export function createAppContext(opts: CreateAppContextOptions): Promise<AppContext> {
  throw new Error("not implemented");
}
