import fs from "node:fs";
import path from "node:path";
import { vi, type Mock } from "vitest";
import type { AppContext } from "../../src/app/context.js";
import { AppSettingsStore } from "../../src/config/app-settings.js";
import { getPaths } from "../../src/config/paths.js";
import type { Engine } from "../../src/engine/engine.js";
import { EventBus } from "../../src/events/bus.js";
import { GraphStore } from "../../src/graphs/graph-store.js";
import { HookRouter } from "../../src/hooks/hook-router.js";
import { PtyManager } from "../../src/pty/pty-manager.js";
import { openDatabase, Store } from "../../src/store/store.js";

export const TEST_TOKEN = "test-token-123";

const ENGINE_METHODS = [
  "startRun",
  "getRun",
  "cancelRun",
  "cleanupRun",
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
] as const;

type AnyFn = (...args: any[]) => any;
export type EngineMock = Record<(typeof ENGINE_METHODS)[number], Mock<AnyFn>>;

/** Engine methods used by the HTTP layer, all mocked (no active runs; cancel/cleanup resolve). */
export function mockEngine(): EngineMock {
  const engine = Object.fromEntries(ENGINE_METHODS.map((m) => [m, vi.fn()])) as EngineMock;
  engine.activeRunForGraph.mockReturnValue(null);
  engine.cancelRun.mockResolvedValue(undefined);
  engine.cleanupRun.mockResolvedValue(undefined);
  engine.resumeRun.mockResolvedValue(undefined);
  engine.supportedNodeTypes.mockReturnValue(["prompt", "command", "shell", "commit"]);
  return engine;
}

/**
 * AppContext for HTTP/WS tests: real store (in memory), bus, graph store, settings, hook router and
 * PTY manager; mocked engine. Modules the HTTP layer never touches are left out.
 */
export function createTestContext(repo: string, root: string, env: NodeJS.ProcessEnv = {}): { ctx: AppContext; engine: EngineMock } {
  const fullEnv: NodeJS.ProcessEnv = { PG_HOME: path.join(root, "pg-home"), ...env };
  const paths = getPaths(fullEnv);
  fs.mkdirSync(paths.home, { recursive: true });
  const bus = new EventBus();
  const engine = mockEngine();
  const ctx = {
    repo: { path: repo, name: path.basename(repo) },
    paths,
    token: TEST_TOKEN,
    warnings: ["gh not found: PR nodes will fail"],
    bus,
    store: new Store(openDatabase(":memory:")),
    graphs: new GraphStore(repo, bus),
    settings: new AppSettingsStore(paths.settingsFile),
    ptys: new PtyManager(bus, () => null),
    hooks: new HookRouter(),
    notifier: { detectPlatform: async () => "none" },
    engine: engine as unknown as Engine,
    port: 0,
    env: fullEnv,
  } as unknown as AppContext;
  return { ctx, engine };
}
