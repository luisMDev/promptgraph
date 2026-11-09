import { isFinalRunStatus, type ServerMessage } from "@promptgraph/shared";
import { enteredMergeConflict } from "../lib/run-view";
import { dropChatStore, liveChatStores, peekChatStore } from "./chat-store";
import { useDaemonStore } from "./daemon-store";
import { dropRepoCache, liveRepoCaches, peekRepoCache } from "./repo-cache";
import { toast } from "./toast-store";
import { useVoiceStore } from "./voice-store";
import { openMergeShell } from "./view/actions";
import { discardEditorsOf, findEditorStore, liveEditorStores } from "./view/editor-store";
import type { RunStoreApi } from "./view/run-store";
import type { ViewUiStoreApi } from "./view/ui-store";

/** What the dispatcher needs of a mounted view. */
export interface LiveView {
  repoId: string;
  run: RunStoreApi;
  ui: ViewUiStoreApi;
}

export interface Dispatcher {
  handle(msg: ServerMessage): void;
  /** A mounted view receives the updates of its repository and runs; returns unregister. */
  registerView(view: LiveView): () => void;
  /**
   * The repository was removed (`repo:removed`, or a DELETE from this page): its editor stores are
   * discarded with a toast, its views release their run subscriptions and PTYs, its cache is dropped.
   * Idempotent.
   */
  repoRemoved(repoId: string): void;
}

const PENDING_REFRESH_MS = 300;

/**
 * Fans WebSocket messages out to the live stores (DESIGN §12.2, §13.4): each view's run store (which filters
 * by its selected run), the shared editor store of the graph concerned, the repository's cache and chat store
 * (§21), the voice store (§22) and the daemon store. The hello counter and the pending-refresh timers belong to the instance.
 */
export function createDispatcher(): Dispatcher {
  const views = new Set<LiveView>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let helloCount = 0;

  function refreshPendingSoon(repoId: string): void {
    if (pendingTimers.has(repoId)) return;
    pendingTimers.set(
      repoId,
      setTimeout(() => {
        pendingTimers.delete(repoId);
        void peekRepoCache(repoId)?.getState().refreshPending();
      }, PENDING_REFRESH_MS),
    );
  }

  /** After a reconnect: refetch everything that may have changed while disconnected. */
  function refreshAll(): void {
    const daemon = useDaemonStore.getState();
    void daemon.loadInfo();
    void daemon.loadUsageLimits();
    const listedBefore = new Set((daemon.repos ?? []).map((r) => r.id));
    void daemon.loadRepos().then(() => dropReposGoneWhileDisconnected(listedBefore));
    for (const cache of liveRepoCaches()) {
      const state = cache.getState();
      // A cache whose first load failed while disconnected (its view shows the error) loads again.
      if (!state.info || state.infoError) void state.load();
      else void state.refreshGraphs().catch(() => undefined);
      void state.refreshPending();
    }
    for (const view of views) {
      const run = view.run.getState();
      void run.reloadSelected();
      if (run.graphId) void run.loadRuns(run.graphId).catch(() => undefined);
    }
    for (const editor of liveEditorStores()) void editor.getState().checkExternalChange();
    for (const chat of liveChatStores()) void chat.getState().resync();
  }

  /**
   * `repo:removed` is a one-shot broadcast: one missed while disconnected would leave views and editor
   * stores of that repository on stale data. After a successful reload of the list, every repository that
   * existed (listed before, or its info or a graph was loaded) and is still held by a view, a cache or an
   * editor store but is no longer listed is treated as removed. An id that never existed is left to its
   * view's not-found state.
   */
  function dropReposGoneWhileDisconnected(listedBefore: ReadonlySet<string>): void {
    const { repos, reposError, removed } = useDaemonStore.getState();
    if (!repos || reposError) return;
    const listed = new Set(repos.map((r) => r.id));
    const existed = new Set(listedBefore);
    for (const cache of liveRepoCaches()) if (cache.getState().info) existed.add(cache.getState().repoId);
    for (const editor of liveEditorStores()) if (editor.getState().graph) existed.add(editor.getState().repoId);
    const held = new Set<string>([...views].map((v) => v.repoId));
    for (const cache of liveRepoCaches()) held.add(cache.getState().repoId);
    for (const editor of liveEditorStores()) held.add(editor.getState().repoId);
    for (const repoId of held) if (existed.has(repoId) && !listed.has(repoId) && !removed[repoId]) repoRemoved(repoId);
  }

  function repoRemoved(repoId: string): void {
    const cache = peekRepoCache(repoId)?.getState();
    const known = useDaemonStore.getState().repos?.find((r) => r.id === repoId);
    const name = known?.name ?? cache?.info?.name ?? repoId;
    for (const graph of discardEditorsOf(repoId)) toast("error", `${name} was removed; unsaved changes to ${graph} were not saved.`);
    for (const view of views) {
      if (view.repoId !== repoId) continue;
      view.run.getState().dispose();
      view.ui.getState().closeAllTerminals();
    }
    const timer = pendingTimers.get(repoId);
    if (timer) clearTimeout(timer);
    pendingTimers.delete(repoId);
    dropRepoCache(repoId);
    dropChatStore(repoId);
    useDaemonStore.getState().markRemoved(repoId, cache?.info ? { id: repoId, path: cache.info.path, name: cache.info.name } : null);
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        if (helloCount++ > 0) refreshAll();
        return;
      case "repo:status":
        useDaemonStore.getState().applyRepoStatus(msg.repo);
        peekRepoCache(msg.repo.id)?.getState().setSummary(msg.repo);
        return;
      case "usage:limits":
        useDaemonStore.getState().applyUsageLimits(msg.limits);
        return;
      case "repo:removed":
        repoRemoved(msg.repoId);
        return;
      case "run:update": {
        for (const view of views) if (view.repoId === msg.repoId) view.run.getState().applyRunUpdate(msg.run);
        const editor = findEditorStore(msg.repoId, msg.run.graphId)?.getState();
        if (editor) {
          if (!isFinalRunStatus(msg.run.status)) editor.setActiveRunId(msg.run.id);
          else if (editor.activeRunId === msg.run.id) editor.setActiveRunId(null);
        }
        refreshPendingSoon(msg.repoId);
        return;
      }
      case "run:deleted":
        for (const view of views) if (view.repoId === msg.repoId) view.run.getState().removeRun(msg.runId);
        refreshPendingSoon(msg.repoId);
        return;
      case "node:update":
        for (const view of views) {
          const runs = view.run.getState();
          if (runs.selectedRunId !== msg.nodeRun.runId) continue;
          const prev = runs.detail?.nodeRuns.find((n) => n.id === msg.nodeRun.id);
          runs.applyNodeUpdate(msg.nodeRun);
          if (enteredMergeConflict(prev, msg.nodeRun)) openMergeShell(view, msg.nodeRun);
        }
        return;
      case "lane:update":
        for (const view of views) view.run.getState().applyLaneUpdate(msg.lane);
        return;
      case "brief:update":
        for (const view of views) view.run.getState().applyBriefUpdate(msg.entry);
        return;
      case "graphs:changed":
        void peekRepoCache(msg.repoId)
          ?.getState()
          .refreshGraphs()
          .catch(() => undefined);
        void findEditorStore(msg.repoId, msg.graphId)?.getState().checkExternalChange();
        return;
      case "chat:item":
      case "chat:delta":
      case "chat:status":
      case "chat:session":
      case "chat:deleted":
        peekChatStore(msg.repoId)?.getState().applyServerMessage(msg);
        return;
      case "voice:partial":
      case "voice:final":
      case "voice:error":
        useVoiceStore.getState().applyServerMessage(msg);
        return;
      default:
        return;
    }
  }

  return {
    handle,
    registerView(view) {
      views.add(view);
      return () => views.delete(view);
    },
    repoRemoved,
  };
}
