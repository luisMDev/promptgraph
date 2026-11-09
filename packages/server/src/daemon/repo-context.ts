import { ChatManager } from "../chat/chat-manager.js";
import { createLinkedIssuesResolver } from "../chat/issues.js";
import { resolveChatMcp } from "../chat/launch.js";
import { SUPPORTED_PHASE } from "../config/version.js";
import { RunBriefer } from "../engine/brief.js";
import { Engine } from "../engine/engine.js";
import { GraphStore, type GraphWatch } from "../graphs/graph-store.js";
import { bundledMarketplaceRoot, currentCliEntry } from "../mcp/setup.js";
import type { OwnedPtys } from "../pty/pty-manager.js";
import { ClaudeRunner } from "../runners/claude/claude-runner.js";
import { createRunnerRegistry } from "../runners/registry.js";
import type { RunnerRegistry } from "../runners/types.js";
import type { RepoRow } from "../store/store.js";
import { errorMessage } from "../util/text.js";
import { LaneManager, type RepoRef } from "../workspace/lane-manager.js";
import type { DaemonContext } from "./context.js";

/** One registered repository's engine and stores (DESIGN §4.2). */
export interface RepoContext {
  repo: RepoRef;
  graphs: GraphStore;
  lanes: LaneManager;
  claude: ClaudeRunner;
  runners: RunnerRegistry;
  engine: Engine;
  /** Chat panel sessions of this repository (§21); processes run in its main checkout. */
  chat: ChatManager;
  /** This repository's PTYs (node, setup-, shell-, reopen-). */
  ptys: OwnedPtys;
  /** Set when the graph watcher could not start or stopped; the repository keeps working without live reloads. */
  readonly watchError: string | null;
  /**
   * Creates `.promptgraph/graphs/`, starts the graph watcher, `git worktree prune`, prunes snapshot
   * refs. Idempotent; a failure leaves the context usable for reads and may be retried.
   */
  activate(): Promise<void>;
  /**
   * Unsubscribes the PTY input listener, stops the watcher, ends the chat processes, shuts the engine down
   * and waits for its chains (no timeout).
   */
  dispose(): Promise<void>;
}

/**
 * Builds a repository's context without side effects: no directory is created, no watcher started and
 * no git command run (reads only). Node and `reopen-` PTYs are owned by the repository
 * (`ptys.owned(repo.id)`), so stopping it kills only its own.
 */
export function createRepoContext(daemon: DaemonContext, row: RepoRow): RepoContext {
  const { store, bus, paths, hooks, env } = daemon;
  const repo: RepoRef = { id: row.id, path: row.path, name: row.name };
  const graphs = new GraphStore(repo.path, bus, repo.id);
  const ptys = daemon.ptys.owned(repo.id);
  const lanes = new LaneManager({ store, bus, paths, repo });
  // The port is read when a node starts, i.e. once the daemon listens.
  const claude = new ClaudeRunner({ ptys, hooks, paths, pgHookPath: daemon.pgHookPath, endpoint: () => ({ port: daemon.port, hookSecret: daemon.hookSecret }), env });
  const runners = createRunnerRegistry({ claude, ptys, lanes, paths, env, linear: daemon.linear });
  const engine = new Engine({
    store,
    graphs,
    lanes,
    ptys,
    runners,
    claude,
    bus,
    paths,
    repo,
    phase: SUPPORTED_PHASE,
    env,
    billingMode: async () => (await daemon.claudeAuth.get(repo.path)).billingMode,
    brief: new RunBriefer({ store, bus, repo, env }),
  });
  const offUserInput = daemon.ptys.onUserInput((ptyId) => engine.handleUserInput(ptyId));
  const chat = new ChatManager({
    store,
    bus,
    repoId: repo.id,
    repoPath: repo.path,
    env,
    spawner: daemon.chatSpawner,
    onRateLimit: (info) => daemon.usageLimits.observe(info),
    linkedIssues: createLinkedIssuesResolver({
      graphIssues: (graphId) => graphs.get(graphId).graph.issues ?? [],
      issueContext: (ids) => daemon.linear.issueContext(ids),
    }),
    mcp: () =>
      resolveChatMcp({
        repoPath: repo.path,
        cliEntry: currentCliEntry(),
        nodePath: process.execPath,
        execArgv: process.execArgv,
        marketplaceRoot: bundledMarketplaceRoot(),
        binDir: paths.binDir,
      }),
  });

  let watch: GraphWatch | null = null;
  let watchError: string | null = null;
  let pruned = false;
  let disposed: Promise<void> | null = null;
  const reportWatchError = (err: Error) => {
    watchError = `Graph watcher stopped (external edits are not picked up live): ${errorMessage(err)}`;
    console.error(`promptgraph: ${repo.path}: ${watchError}`);
    bus.emit("repo:changed", { repoId: repo.id });
  };

  return {
    repo,
    graphs,
    lanes,
    claude,
    runners,
    engine,
    chat,
    ptys,
    get watchError() {
      return watchError;
    },
    async activate() {
      if (disposed) throw new Error(`Repository ${repo.path} is being removed`);
      graphs.ensureDir();
      if (!watch) {
        // A watcher failure (inotify limit) is reported through onError and never fails the activation.
        watch = graphs.watch({ onError: reportWatchError });
      }
      if (!pruned) {
        await engine.prune();
        pruned = true;
      }
    },
    dispose() {
      return (disposed ??= (async () => {
        offUserInput();
        watch?.stop();
        watch = null;
        await Promise.all([engine.shutdown(), chat.shutdown()]);
        await engine.drain();
      })());
    },
  };
}
