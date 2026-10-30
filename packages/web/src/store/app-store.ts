import type { AppSettings, GraphListItem, NodeRun, RepoInfoResponse, RunDetail, SlashCommand } from "@promptgraph/shared";
import { create } from "zustand";
import { api, errorMessage } from "../api/rest";

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
    nodeLabels: Object.fromEntries(run.graphSnapshot.nodes.map((n) => [n.id, n.label || n.type])),
  };
}

/** App-wide data that is not tied to the edited graph or the selected run. */
export interface AppState {
  repo: RepoInfoResponse | null;
  settings: AppSettings | null;
  graphs: GraphListItem[];
  /** null until first requested (lazy, for the command picker). */
  commands: SlashCommand[] | null;
  /** waiting_approval node runs across all runs of the repo, oldest first. */
  pending: NodeRun[];
  /** Run info of every run in `pending` (best effort: missing while loading or when the fetch failed). */
  pendingRuns: Record<string, PendingRunInfo>;
  connected: boolean;
  bootError: string | null;

  boot(): Promise<void>;
  refreshGraphs(): Promise<void>;
  refreshPending(): Promise<void>;
  loadCommands(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  setConnected(connected: boolean): void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  repo: null,
  settings: null,
  graphs: [],
  commands: null,
  pending: [],
  pendingRuns: {},
  connected: false,
  bootError: null,

  async boot() {
    try {
      const [repo, settings, graphs] = await Promise.all([api.repo(), api.getSettings(), api.listGraphs()]);
      set({ repo, settings, graphs: graphs.graphs, bootError: null });
    } catch (err) {
      set({ bootError: errorMessage(err) });
      return;
    }
    void get().refreshPending();
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

  async updateSettings(patch) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, ...patch } });
    try {
      set({ settings: await api.updateSettings(patch) });
    } catch (err) {
      set({ settings: prev });
      throw err;
    }
  },

  setConnected(connected) {
    set({ connected });
  },
}));
