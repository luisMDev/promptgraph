import fs from "node:fs";
import path from "node:path";
import { vi, type Mock } from "vitest";
import type { ChatSpawner } from "../../src/chat/process.js";
import type { AuthStatusRunner } from "../../src/config/claude-auth.js";
import { createDaemonContext, type DaemonContext } from "../../src/daemon/context.js";
import { createRepoContext, type RepoContext } from "../../src/daemon/repo-context.js";
import { RepoRegistry } from "../../src/daemon/registry.js";
import type { Engine } from "../../src/engine/engine.js";
import { VoiceService } from "../../src/voice/voice-service.js";
import type { LinearFetch } from "../../src/linear/client.js";

export const TEST_TOKEN = "test-token-123";
/** Hook secret of the test daemon (hook tokens derive from it, never from the token). */
export const TEST_HOOK_SECRET = "test-hook-secret-456";

const ENGINE_METHODS = [
  "startRun",
  "getRun",
  "getReport",
  "getLaneDiff",
  "cancelRun",
  "cleanupRun",
  "deleteRun",
  "activeRunForGraph",
  "done",
  "fail",
  "retry",
  "skip",
  "setHold",
  "submitApproval",
  "getApprovalInfo",
  "getDiff",
  "reopenSession",
  "closeReopenedSession",
  "resumeRun",
  "supportedNodeTypes",
  "handleUserInput",
  "prune",
  "shutdown",
  "drain",
] as const;

type AnyFn = (...args: any[]) => any;
export type EngineMock = Record<(typeof ENGINE_METHODS)[number], Mock<AnyFn>>;

/** Engine methods used by the HTTP layer and the repository lifecycle, all mocked (no active runs). */
export function mockEngine(): EngineMock {
  const engine = Object.fromEntries(ENGINE_METHODS.map((m) => [m, vi.fn()])) as EngineMock;
  engine.activeRunForGraph.mockReturnValue(null);
  for (const m of ["cancelRun", "cleanupRun", "deleteRun", "resumeRun", "prune", "shutdown", "drain"] as const) engine[m].mockResolvedValue(undefined);
  engine.supportedNodeTypes.mockReturnValue(["prompt", "command", "shell", "commit"]);
  return engine;
}

/** A new browser session of `ctx`: the Cookie header value `pg_session=<value>`. */
export function sessionCookie(ctx: DaemonContext, label = "Test"): string {
  return `pg_session=${ctx.sessions.create(label)}`;
}

export interface TestDaemon {
  ctx: DaemonContext;
  /** repoId of each `repos` entry, in order. */
  repoIds: string[];
  /** The mocked engine of each repository (mockEngines only), by repoId. */
  engines: Map<string, EngineMock>;
  /** The loaded context of a registered repository. */
  repo(repoId: string): Promise<RepoContext>;
  close(): Promise<void>;
}

export interface TestDaemonOptions {
  /** Repositories registered (registry.add: activated) before the daemon is returned. */
  repos?: string[];
  /** PG_HOME etc.; PG_HOME defaults to `<root>/pg-home`. */
  env?: NodeJS.ProcessEnv;
  root: string;
  /** Replace every repository's engine with a mockEngine() (HTTP and WS tests). */
  mockEngines?: boolean;
  warnings?: string[];
  /** Chat process spawner of every repository's ChatManager; default: none (tests never start the real claude). */
  chatSpawner?: ChatSpawner;
  /** `claude auth status` of every repository (§23.1); default: NO_CLAUDE_AUTH. */
  authStatusRunner?: AuthStatusRunner;
  /** fetch for Linear's API (§24); default: NO_LINEAR (tests never reach api.linear.app). */
  linearFetch?: LinearFetch;
}

/** Default Linear fetch of test daemons: a network error, so no test reaches the real API. */
export const NO_LINEAR: LinearFetch = async () => {
  throw new Error("Linear is not available in tests");
};

/** Default auth status of test daemons: a claude.ai Pro login, without running claude. */
export const NO_CLAUDE_AUTH: AuthStatusRunner = async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });

/** Default chat spawner of test daemons: tests never start the real claude. */
export const NO_CLAUDE: ChatSpawner = () => {
  throw new Error("claude is not available in tests");
};

/**
 * A DaemonContext without HTTP server (tests call createHttpApp(ctx) / new WsHub(ctx) themselves): real
 * store, bus, settings, PTY manager, hook router and registry over a temp PG_HOME, token TEST_TOKEN,
 * hook secret TEST_HOOK_SECRET, chat spawner NO_CLAUDE, auth status NO_CLAUDE_AUTH and Linear fetch NO_LINEAR unless given, voice service rooted at `root`.
 * With `mockEngines`, each repository's engine is an EngineMock.
 */
export async function createTestDaemon(opts: TestDaemonOptions): Promise<TestDaemon> {
  const env: NodeJS.ProcessEnv = { PG_HOME: path.join(opts.root, "pg-home"), ...opts.env };
  fs.mkdirSync(env.PG_HOME!, { recursive: true });
  const ctx = createDaemonContext({
    token: TEST_TOKEN,
    warnings: opts.warnings ?? ["gh not found: PR nodes will fail"],
    env,
    chatSpawner: opts.chatSpawner ?? NO_CLAUDE,
    authStatusRunner: opts.authStatusRunner ?? NO_CLAUDE_AUTH,
    linearFetch: opts.linearFetch ?? NO_LINEAR,
  });
  ctx.hookSecret = TEST_HOOK_SECRET;
  // Never the user's ~/whisper.cpp or ~/.claude: home is the test root; PATH comes only from `env`.
  ctx.voice = new VoiceService({ settings: ctx.settings, paths: ctx.paths, env, homeDir: opts.root });
  const engines = new Map<string, EngineMock>();
  ctx.registry = new RepoRegistry({
    store: ctx.store,
    bus: ctx.bus,
    paths: ctx.paths,
    env,
    legacyLocks: ctx.legacyLocks,
    createContext: (row) => {
      const repo = createRepoContext(ctx, row);
      if (!opts.mockEngines) return repo;
      const engine = mockEngine();
      engines.set(row.id, engine);
      // The real engine's write guard was installed on the graph store: remove it with the engine.
      repo.graphs.setWriteGuard(null);
      return Object.assign(repo, { engine: engine as unknown as Engine });
    },
  });
  const repoIds: string[] = [];
  for (const r of opts.repos ?? []) repoIds.push((await ctx.registry.add(r)).id);
  let closed: Promise<void> | null = null;
  return {
    ctx,
    repoIds,
    engines,
    repo: (id) => ctx.registry.load(id),
    close: () =>
      (closed ??= (async () => {
        await Promise.all([ctx.registry.shutdownAll(), ctx.voice.shutdown()]);
        await ctx.ptys.killAll();
        ctx.legacyLocks.releaseAll();
        ctx.store.db.close();
      })()),
  };
}
