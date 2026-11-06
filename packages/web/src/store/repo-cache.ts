import { nodeDisplayLabel, type ClaudeAuthInfo, type GraphListItem, type NodeRun, type RepoInfoResponse, type RepoSummary, type RunDetail, type SlashCommand } from "@promptgraph/shared";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiRequestError, errorMessage, repoApi, type RepoApi } from "../api/rest";

/** What the pending list and the approval dialog show about the run of a pending node run. */
export interface PendingRunInfo {
  graphId: string;
  graphName: string;
  shortId: string;
  /** Snapshot node id → label. */
  nodeLabels: Record<string, string>;
}

export function pendingRunInfo(detail: RunDetail): PendingRunInfo {
  const { run } = detail;
  return {
    graphId: run.graphId,
    graphName: run.graphName,
    shortId: run.shortId,
    nodeLabels: Object.fromEntries(run.graphSnapshot.nodes.map((n) => [n.id, nodeDisplayLabel(n)])),
  };
}

export interface LoadError {
  message: string;
  /** HTTP status, or null when the daemon was not reached. */
  status: number | null;
  code: string | null;
}

function loadError(err: unknown): LoadError {
  return err instanceof ApiRequestError
    ? { message: err.message, status: err.status, code: err.body.code ?? null }
    : { message: errorMessage(err), status: null, code: null };
}

/**
 * Data of one repository, cached once and shared by every view of it (DESIGN §13.4): info, graph list,
 * slash commands, pending approvals and the last `RepoSummary`. Loading is lazy; the WS dispatcher
 * refreshes it on `run:update` / `graphs:changed` of this repository.
 */
export interface RepoCacheState {
  repoId: string;
  api: RepoApi;
  info: RepoInfoResponse | null;
  infoError: LoadError | null;
  /** null until loaded. */
  graphs: GraphListItem[] | null;
  /** null until first requested (lazy, for the command picker). */
  commands: SlashCommand[] | null;
  /** waiting_approval node runs across all runs of the repo, oldest first. */
  pending: NodeRun[];
  /** Run info of every run in `pending` (best effort: missing while loading or when the fetch failed). */
  pendingRuns: Record<string, PendingRunInfo>;
  summary: RepoSummary | null;
  /** How Claude is billed in this repository (§23.1); null until loaded or when the request failed. */
  claudeAuth: ClaudeAuthInfo | null;

  /** Info + graph list, once (a failed load is retried on the next call). */
  load(): Promise<void>;
  refreshGraphs(): Promise<void>;
  refreshPending(): Promise<void>;
  loadCommands(): Promise<void>;
  /** GET …/claude-auth (best effort: a failure keeps the last value). */
  loadClaudeAuth(refresh?: boolean): Promise<void>;
  setSummary(summary: RepoSummary): void;
}

export type RepoCache = StoreApi<RepoCacheState>;

export function createRepoCache(repoId: string, api: RepoApi = repoApi(repoId)): RepoCache {
  let loading: Promise<void> | null = null;
  return createStore<RepoCacheState>()((set, get) => ({
    repoId,
    api,
    info: null,
    infoError: null,
    graphs: null,
    commands: null,
    pending: [],
    pendingRuns: {},
    summary: null,
    claudeAuth: null,

    load() {
      if (get().info && get().graphs) return Promise.resolve();
      loading ??= (async () => {
        try {
          const [info, { graphs }] = await Promise.all([api.info(), api.listGraphs()]);
          set({ info, graphs, infoError: null });
        } catch (err) {
          set({ infoError: loadError(err) });
          loading = null;
          return;
        }
        void get().refreshPending();
      })();
      return loading;
    },

    async refreshGraphs() {
      const { graphs } = await api.listGraphs();
      set({ graphs });
    },

    async refreshPending() {
      let nodeRuns: NodeRun[];
      try {
        ({ nodeRuns } = await api.pending());
      } catch {
        // Counter is best effort; the next run:update retries.
        return;
      }
      const runIds = [...new Set(nodeRuns.map((n) => n.runId))];
      const known = get().pendingRuns;
      set({ pending: [...nodeRuns].sort((a, b) => a.updatedAt - b.updatedAt) });
      // Only runs that are (still) pending stay in the cache.
      const keep = (all: Record<string, PendingRunInfo>) => {
        const ids = new Set(get().pending.map((n) => n.runId));
        return Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)));
      };
      set({ pendingRuns: keep(known) });
      const missing = runIds.filter((id) => !known[id]);
      const fetched = await Promise.all(missing.map((id) => api.getRun(id).then(pendingRunInfo, () => null)));
      const add: Record<string, PendingRunInfo> = {};
      missing.forEach((id, i) => {
        const info = fetched[i];
        if (info) add[id] = info;
      });
      if (Object.keys(add).length) set({ pendingRuns: keep({ ...get().pendingRuns, ...add }) });
    },

    async loadCommands() {
      if (get().commands !== null) return;
      set({ commands: [] });
      try {
        const { commands } = await api.commands();
        set({ commands });
      } catch {
        set({ commands: null });
      }
    },

    async loadClaudeAuth(refresh = false) {
      try {
        set({ claudeAuth: await api.claudeAuth(refresh) });
      } catch {
        // The badge stays as it was; the next open retries.
      }
    },

    setSummary(summary) {
      set({ summary });
    },
  }));
}

const caches = new Map<string, RepoCache>();

/** The cache of a repository, created on first use. */
export function getRepoCache(repoId: string): RepoCache {
  let cache = caches.get(repoId);
  if (!cache) {
    cache = createRepoCache(repoId);
    caches.set(repoId, cache);
  }
  return cache;
}

/** The cache if some view already created it. */
export function peekRepoCache(repoId: string): RepoCache | undefined {
  return caches.get(repoId);
}

/** `repo:removed`: the next view of this repository starts from scratch. */
export function dropRepoCache(repoId: string): void {
  caches.delete(repoId);
}

export function liveRepoCaches(): RepoCache[] {
  return [...caches.values()];
}

/** Tests: injects a cache (e.g. with a fake API). */
export function setRepoCache(repoId: string, cache: RepoCache): void {
  caches.set(repoId, cache);
}

/** Tests: forgets every cache. */
export function clearRepoCaches(): void {
  caches.clear();
}

export function useRepoCache<T>(repoId: string, selector: (s: RepoCacheState) => T): T {
  return useStore(getRepoCache(repoId), selector);
}
