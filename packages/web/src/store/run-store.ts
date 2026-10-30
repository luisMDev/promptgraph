import type { Lane, NodeRun, RunDetail, RunSummary } from "@promptgraph/shared";
import { create } from "zustand";
import { api, errorMessage } from "../api/rest";
import { wsClient } from "../api/ws";
import { currentNodeRuns, runInfoOf, upsertNodeRun, type RunInfo } from "../lib/run-view";

/** Runs: history list (from REST + run:update), the selected run's detail (node:update/lane:update merged in). */
export interface RunState {
  runs: RunSummary[];
  /** null = edit mode. */
  selectedRunId: string | null;
  detail: RunDetail | null;
  /** Current (latest iteration+attempt) node run per node id of the selected run. */
  currentByNode: Record<string, NodeRun>;
  lanes: Record<string, Lane>;
}

export interface RunStore extends RunState {
  /** Graph whose history is in `runs`. */
  graphId: string | null;
  detailError: string | null;
  /** Node inspected on the run canvas (snapshot node id). */
  selectedNodeId: string | null;
  /** Lanes and PRs of runs expanded in the history (loaded on demand, refreshed on status/cleanup changes). */
  runInfo: Record<string, RunInfo>;

  loadRuns(graphId: string): Promise<void>;
  clearRuns(): void;
  selectNode(nodeId: string | null): void;
  /** Opens a run on the canvas (subscribes to its live updates); null returns to edit mode. */
  selectRun(runId: string | null): Promise<void>;
  /** Shows a freshly started run without an extra fetch. */
  showRun(detail: RunDetail): void;
  /** Re-fetches the selected run (e.g. after a WS reconnect, when updates may have been missed). */
  reloadSelected(): Promise<void>;
  /** (Re)loads the history details of a run. */
  loadRunInfo(runId: string): Promise<void>;
  applyRunUpdate(run: RunSummary): void;
  applyNodeUpdate(nodeRun: NodeRun): void;
  applyLaneUpdate(lane: Lane): void;
}

export interface RunSubscriptions {
  subscribe(runId: string): void;
  unsubscribe(runId: string): void;
  fetchRun(runId: string): Promise<RunDetail>;
}

let deps: RunSubscriptions = {
  subscribe: (id) => wsClient.subscribeRun(id),
  unsubscribe: (id) => wsClient.unsubscribeRun(id),
  fetchRun: (id) => api.getRun(id),
};

/** Test seam. */
export function setRunStoreDeps(d: RunSubscriptions): void {
  deps = d;
}

type BufferedUpdate = { kind: "node"; nodeRun: NodeRun } | { kind: "lane"; lane: Lane } | { kind: "run"; run: RunSummary };
/** Updates for the selected run that arrive while its detail is being fetched; applied on top of it. */
let buffer: BufferedUpdate[] = [];

function lanesById(lanes: readonly Lane[]): Record<string, Lane> {
  return Object.fromEntries(lanes.map((l) => [l.id, l]));
}

function upsertRun(runs: readonly RunSummary[], run: RunSummary): RunSummary[] {
  const i = runs.findIndex((r) => r.id === run.id);
  if (i === -1) return [run, ...runs].sort((a, b) => b.startedAt - a.startedAt);
  const next = runs.slice();
  next[i] = run;
  return next;
}

export const useRunStore = create<RunStore>()((set, get) => ({
  runs: [],
  selectedRunId: null,
  detail: null,
  currentByNode: {},
  lanes: {},
  graphId: null,
  detailError: null,
  selectedNodeId: null,
  runInfo: {},

  async loadRuns(graphId) {
    if (get().graphId !== graphId) set({ runInfo: {} });
    set({ graphId, runs: get().graphId === graphId ? get().runs : [] });
    const { runs } = await api.listRuns(graphId, 100);
    if (get().graphId === graphId) set({ runs });
  },

  clearRuns() {
    set({ graphId: null, runs: [], runInfo: {} });
  },

  async loadRunInfo(runId) {
    try {
      const info = runInfoOf(await deps.fetchRun(runId));
      set({ runInfo: { ...get().runInfo, [runId]: info } });
    } catch {
      // Best effort: the row keeps what it showed (or nothing).
    }
  },

  selectNode(nodeId) {
    set({ selectedNodeId: nodeId });
  },

  async selectRun(runId) {
    const prev = get().selectedRunId;
    if (prev === runId) return;
    if (prev) deps.unsubscribe(prev);
    buffer = [];
    set({ selectedRunId: runId, detail: null, currentByNode: {}, lanes: {}, detailError: null, selectedNodeId: null });
    if (!runId) return;
    deps.subscribe(runId);
    try {
      const detail = await deps.fetchRun(runId);
      if (get().selectedRunId !== runId) return;
      const pending = buffer;
      buffer = [];
      setDetail(detail);
      for (const u of pending) applyBuffered(u);
    } catch (err) {
      if (get().selectedRunId === runId) set({ detailError: errorMessage(err) });
    }
  },

  showRun(detail) {
    const prev = get().selectedRunId;
    if (prev && prev !== detail.run.id) deps.unsubscribe(prev);
    buffer = [];
    deps.subscribe(detail.run.id);
    set({ selectedRunId: detail.run.id, detailError: null, selectedNodeId: null, runs: detail.run.graphId === get().graphId ? upsertRun(get().runs, stripSnapshot(detail)) : get().runs });
    setDetail(detail);
  },

  async reloadSelected() {
    const runId = get().selectedRunId;
    if (!runId) return;
    try {
      const detail = await deps.fetchRun(runId);
      if (get().selectedRunId === runId) setDetail(detail);
    } catch (err) {
      if (get().selectedRunId === runId) set({ detailError: errorMessage(err) });
    }
  },

  applyRunUpdate(run) {
    const s = get();
    const prev = s.runs.find((r) => r.id === run.id);
    if (run.graphId === s.graphId) set({ runs: upsertRun(s.runs, run) });
    // Lanes change state on run end and cleanup; usage-only updates are frequent and do not need a fetch.
    if (s.runInfo[run.id] && (prev?.status !== run.status || prev.cleanedUp !== run.cleanedUp)) void get().loadRunInfo(run.id);
    if (run.id !== s.selectedRunId) return;
    if (!s.detail) buffer.push({ kind: "run", run });
    else set({ detail: { ...s.detail, run: { ...s.detail.run, ...run } } });
  },

  applyNodeUpdate(nodeRun) {
    const s = get();
    if (nodeRun.runId !== s.selectedRunId) return;
    if (!s.detail) {
      buffer.push({ kind: "node", nodeRun });
      return;
    }
    // A REST response (e.g. after Approve) can arrive after the WS updates that followed it: keep the newer.
    const known = s.detail.nodeRuns.find((n) => n.id === nodeRun.id);
    if (known && known.updatedAt > nodeRun.updatedAt) return;
    const nodeRuns = upsertNodeRun(s.detail.nodeRuns, nodeRun);
    set({ detail: { ...s.detail, nodeRuns }, currentByNode: currentNodeRuns(nodeRuns) });
  },

  applyLaneUpdate(lane) {
    const s = get();
    if (lane.runId !== s.selectedRunId) return;
    if (!s.detail) {
      buffer.push({ kind: "lane", lane });
      return;
    }
    const others = s.detail.lanes.filter((l) => l.id !== lane.id);
    const lanes = [...others, lane].sort((a, b) => a.index - b.index);
    set({ detail: { ...s.detail, lanes }, lanes: lanesById(lanes) });
  },
}));

function setDetail(detail: RunDetail): void {
  useRunStore.setState({ detail, currentByNode: currentNodeRuns(detail.nodeRuns), lanes: lanesById(detail.lanes) });
}

function applyBuffered(u: BufferedUpdate): void {
  const s = useRunStore.getState();
  if (u.kind === "node") s.applyNodeUpdate(u.nodeRun);
  else if (u.kind === "lane") s.applyLaneUpdate(u.lane);
  else s.applyRunUpdate(u.run);
}

function stripSnapshot(detail: RunDetail): RunSummary {
  const { graphSnapshot: _snapshot, ...summary } = detail.run;
  return summary;
}
