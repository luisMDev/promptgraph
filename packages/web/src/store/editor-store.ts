import {
  validateGraph,
  type GetGraphResponse,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphSettings,
  type NodeType,
  type Position,
  type SaveGraphResponse,
  type ValidationResult,
} from "@promptgraph/shared";
import { create } from "zustand";
import { ApiRequestError, api, errorMessage } from "../api/rest";
import * as ops from "../lib/graph-ops";

/** Graph being edited (canvas/palette/inspector). Autosave debounced 500ms (§11.1); validation re-run on change. */
export interface EditorState {
  graph: Graph | null;
  graphHash: string | null;
  modifiedOutside: boolean;
  dirty: boolean;
  saving: boolean;
  validation: ValidationResult;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
}

/** Extensions over the contract interface (see CONTRACTS.md §9 notes). */
export interface EditorStore extends EditorState {
  /** Validation phase (RepoInfoResponse.phase). */
  phase: 1 | 2;
  /** Node types the server can run (RepoInfoResponse.supportedNodeTypes); null = all. */
  supportedNodeTypes: readonly NodeType[] | null;
  /** Id of the opened graph, also when it failed to load. */
  graphId: string | null;
  loading: boolean;
  /** Graph file failed to load (parse/zod error) or was deleted. */
  loadError: string | null;
  saveError: string | null;
  /** A run of this graph is active: the graph is read-only. */
  activeRunId: string | null;
  /** The file changed on disk while there were unsaved local edits. */
  externalChange: boolean;
  /** Multi-selection; selectedNodeId/selectedEdgeId are set only when exactly one element is selected. */
  selectedNodeIds: string[];
  selectedEdgeIds: string[];

  setPhase(phase: 1 | 2, supportedNodeTypes?: readonly NodeType[] | null): void;
  openGraph(id: string): Promise<void>;
  closeGraph(): void;
  /** Applies an edit (no-op while read-only); marks dirty, revalidates and schedules the autosave. */
  edit(fn: (graph: Graph) => Graph): void;
  addNode(type: NodeType, position: Position): string | null;
  updateNode(id: string, fn: (node: GraphNode) => GraphNode): void;
  updateEdge(id: string, fn: (edge: GraphEdge) => GraphEdge): void;
  moveNodes(positions: ReadonlyMap<string, Position>): void;
  /** Returns the refusal reason, or null when connected. */
  connect(req: ops.ConnectRequest): string | null;
  removeElements(nodeIds: readonly string[], edgeIds: readonly string[]): void;
  removeSelection(): void;
  setSelection(nodeIds: readonly string[], edgeIds: readonly string[]): void;
  updateSettings(fn: (settings: GraphSettings) => GraphSettings): void;
  rename(name: string): void;
  flushSave(): Promise<void>;
  /** Called on `graphs:changed`: reloads a file changed outside the app, or flags a conflict when dirty. */
  checkExternalChange(graphId: string): Promise<void>;
  reloadFromDisk(): Promise<void>;
  dismissModifiedOutside(): void;
  /** Resolves `externalChange` by keeping the local edits (the pending autosave overwrites the file). */
  keepLocalChanges(): void;
  setActiveRunId(runId: string | null): void;
}

export const AUTOSAVE_DELAY_MS = 500;

export interface EditorPersistence {
  load(id: string): Promise<GetGraphResponse>;
  save(graph: Graph): Promise<SaveGraphResponse>;
}

let persistence: EditorPersistence = { load: (id) => api.getGraph(id), save: (g) => api.saveGraph(g) };

/** Test seam. */
export function setEditorPersistence(p: EditorPersistence): void {
  persistence = p;
}

const EMPTY_VALIDATION: ValidationResult = { errors: [], warnings: [] };

export function isReadOnly(s: Pick<EditorStore, "graph" | "activeRunId" | "loadError">): boolean {
  return !s.graph || s.activeRunId !== null || s.loadError !== null;
}

function validate(graph: Graph | null, s: Pick<EditorStore, "phase" | "supportedNodeTypes">): ValidationResult {
  if (!graph) return EMPTY_VALIDATION;
  try {
    return validateGraph(graph, { phase: s.phase, ...(s.supportedNodeTypes ? { supportedNodeTypes: s.supportedNodeTypes } : {}) });
  } catch (err) {
    return { errors: [{ code: "invalid_config", message: `Validator crashed: ${errorMessage(err)}` }], warnings: [] };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

function clearSaveTimer(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

const NO_SELECTION = { selectedNodeIds: [], selectedEdgeIds: [], selectedNodeId: null, selectedEdgeId: null };

export const useEditorStore = create<EditorStore>()((set, get) => {
  function scheduleSave(): void {
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void runSave();
    }, AUTOSAVE_DELAY_MS);
  }

  async function runSave(): Promise<void> {
    if (inflight) {
      await inflight;
      if (get().dirty && !saveTimer) return runSave();
      return;
    }
    const { graph, dirty } = get();
    if (!graph || !dirty) return;
    set({ saving: true });
    inflight = (async () => {
      try {
        const res = await persistence.save(graph);
        const cur = get();
        if (cur.graph?.id !== graph.id) return;
        set(cur.graph === graph ? { dirty: false, graphHash: res.hash, saveError: null } : { graphHash: res.hash, saveError: null });
      } catch (err) {
        if (get().graph?.id !== graph.id) return;
        if (err instanceof ApiRequestError && err.body.code === "run_active") {
          set({ saveError: "A run is active: changes cannot be saved until it finishes." });
        } else {
          set({ saveError: `Save failed: ${errorMessage(err)}` });
        }
      } finally {
        set({ saving: false });
        inflight = null;
      }
    })();
    await inflight;
  }

  function applyLoaded(res: GetGraphResponse, keepSelection: boolean): void {
    const selection = keepSelection ? pruneSelection(get(), res.graph) : NO_SELECTION;
    set({
      graph: res.graph,
      graphHash: res.hash,
      modifiedOutside: res.modifiedOutside,
      activeRunId: res.activeRunId,
      dirty: false,
      loading: false,
      loadError: null,
      saveError: null,
      externalChange: false,
      validation: validate(res.graph, get()),
      ...selection,
    });
  }

  return {
    graph: null,
    graphHash: null,
    modifiedOutside: false,
    dirty: false,
    saving: false,
    validation: EMPTY_VALIDATION,
    selectedNodeId: null,
    selectedEdgeId: null,
    phase: 1,
    supportedNodeTypes: null,
    graphId: null,
    loading: false,
    loadError: null,
    saveError: null,
    activeRunId: null,
    externalChange: false,
    selectedNodeIds: [],
    selectedEdgeIds: [],

    setPhase(phase, supportedNodeTypes = null) {
      set({ phase, supportedNodeTypes, validation: validate(get().graph, { phase, supportedNodeTypes }) });
    },

    async openGraph(id) {
      await get().flushSave();
      clearSaveTimer();
      set({ graphId: id, loading: true, loadError: null, graph: null, graphHash: null, dirty: false, validation: EMPTY_VALIDATION, ...NO_SELECTION });
      try {
        const res = await persistence.load(id);
        applyLoaded(res, false);
      } catch (err) {
        set({ loading: false, loadError: errorMessage(err), activeRunId: null, modifiedOutside: false });
      }
    },

    closeGraph() {
      clearSaveTimer();
      set({
        graphId: null,
        graph: null,
        graphHash: null,
        dirty: false,
        loadError: null,
        saveError: null,
        activeRunId: null,
        modifiedOutside: false,
        externalChange: false,
        validation: EMPTY_VALIDATION,
        ...NO_SELECTION,
      });
    },

    edit(fn) {
      const s = get();
      if (isReadOnly(s) || !s.graph) return;
      const next = fn(s.graph);
      if (next === s.graph) return;
      set({ graph: next, dirty: true, validation: validate(next, s), ...pruneSelection(s, next) });
      scheduleSave();
    },

    addNode(type, position) {
      const { graph } = get();
      if (!graph || isReadOnly(get())) return null;
      const node = ops.createNode(graph, type, position);
      get().edit((g) => ops.addNode(g, node));
      get().setSelection([node.id], []);
      return node.id;
    },

    updateNode(id, fn) {
      get().edit((g) => ops.updateNode(g, id, fn));
    },

    updateEdge(id, fn) {
      get().edit((g) => ops.updateEdge(g, id, fn));
    },

    moveNodes(positions) {
      get().edit((g) => ops.moveNodes(g, positions));
    },

    connect(req) {
      const { graph, phase } = get();
      if (!graph || isReadOnly(get())) return "The graph is read-only";
      const error = ops.connectionError(graph, req, phase);
      if (error) return error;
      get().edit((g) => ops.connect(g, req, phase));
      return null;
    },

    removeElements(nodeIds, edgeIds) {
      get().edit((g) => ops.removeElements(g, nodeIds, edgeIds));
    },

    removeSelection() {
      const { selectedNodeIds, selectedEdgeIds } = get();
      get().removeElements(selectedNodeIds, selectedEdgeIds);
    },

    setSelection(nodeIds, edgeIds) {
      const cur = get();
      if (sameIds(cur.selectedNodeIds, nodeIds) && sameIds(cur.selectedEdgeIds, edgeIds)) return;
      set(selectionState(nodeIds, edgeIds));
    },

    updateSettings(fn) {
      get().edit((g) => {
        const settings = fn(g.settings);
        return settings === g.settings ? g : { ...g, settings };
      });
    },

    rename(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      get().edit((g) => (g.name === trimmed ? g : { ...g, name: trimmed }));
    },

    async flushSave() {
      if (saveTimer) {
        clearSaveTimer();
        await runSave();
      } else if (inflight) {
        await inflight;
      }
    },

    async checkExternalChange(graphId) {
      const s = get();
      if (s.graph?.id !== graphId || s.saving || saveTimer) return;
      let res: GetGraphResponse;
      try {
        res = await persistence.load(graphId);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404 && get().graph?.id === graphId) {
          get().closeGraph();
          set({ loadError: "This graph was deleted." });
        }
        return;
      }
      const cur = get();
      if (cur.graph?.id !== graphId || cur.saving || saveTimer) return;
      if (res.hash === cur.graphHash) {
        set({ activeRunId: res.activeRunId });
        return;
      }
      if (cur.dirty) set({ externalChange: true, activeRunId: res.activeRunId });
      else applyLoaded(res, true);
    },

    async reloadFromDisk() {
      const id = get().graph?.id;
      if (!id) return;
      clearSaveTimer();
      try {
        applyLoaded(await persistence.load(id), true);
      } catch (err) {
        set({ saveError: `Reload failed: ${errorMessage(err)}` });
      }
    },

    dismissModifiedOutside() {
      set({ modifiedOutside: false });
    },

    keepLocalChanges() {
      set({ externalChange: false });
      if (get().dirty && !saveTimer) scheduleSave();
    },

    setActiveRunId(runId) {
      set({ activeRunId: runId });
    },
  };
});

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function selectionState(nodeIds: readonly string[], edgeIds: readonly string[]) {
  const single = nodeIds.length + edgeIds.length === 1;
  return {
    selectedNodeIds: [...nodeIds],
    selectedEdgeIds: [...edgeIds],
    selectedNodeId: single ? (nodeIds[0] ?? null) : null,
    selectedEdgeId: single ? (edgeIds[0] ?? null) : null,
  };
}

function pruneSelection(s: Pick<EditorStore, "selectedNodeIds" | "selectedEdgeIds">, graph: Graph) {
  const nodes = new Set(graph.nodes.map((n) => n.id));
  const edges = new Set(graph.edges.map((e) => e.id));
  return selectionState(
    s.selectedNodeIds.filter((id) => nodes.has(id)),
    s.selectedEdgeIds.filter((id) => edges.has(id)),
  );
}
