import type { AppSettings, GraphListItem, NodeRun, RepoInfoResponse, SlashCommand } from "@promptgraph/shared";
import { create } from "zustand";
import { api, errorMessage } from "../api/rest";

/** App-wide data that is not tied to the edited graph or the selected run. */
export interface AppState {
  repo: RepoInfoResponse | null;
  settings: AppSettings | null;
  graphs: GraphListItem[];
  /** null until first requested (lazy, for the command picker). */
  commands: SlashCommand[] | null;
  /** waiting_approval node runs across all runs. */
  pending: NodeRun[];
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
    try {
      const { nodeRuns } = await api.pending();
      set({ pending: nodeRuns });
    } catch {
      // Counter is best effort; the next run:update retries.
    }
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
