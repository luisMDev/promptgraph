import {
  GRAPH_CONFLICT_CODE,
  layeredLayout,
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
  /**
   * The graph was reloaded because it changed outside the editor (chat, MCP, another tool): the version shown before,
   * which "Undo" saves back. Cleared by a local edit, another graph or a dismiss.
   */
  externalUndo: ExternalUndo | null;
  /** Nodes added or changed by the last external change; highlighted on the canvas for HIGHLIGHT_MS. */
  highlightNodeIds: string[];
  /**
   * Local edit history of the open graph, oldest first (at most HISTORY_LIMIT entries). Cleared when another
   * graph opens or the graph is (re)loaded from disk, since a stale version must not be written back silently.
   */
  past: Graph[];
  /** Versions undone since the last edit, the next one to redo first. */
  future: Graph[];

  setPhase(phase: 1 | 2, supportedNodeTypes?: readonly NodeType[] | null): void;
  openGraph(id: string): Promise<void>;
  closeGraph(): void;
  /**
   * Applies an edit (no-op while read-only); marks dirty, revalidates, records an undo step and schedules the
   * autosave. Consecutive edits with the same `coalesceKey` less than HISTORY_COALESCE_MS apart (a drag, typing
   * in a field) share one undo step.
   */
  edit(fn: (graph: Graph) => Graph, coalesceKey?: string): void;
  /** Reverts the last local edit, or the last external change when that came after it (see undoExternalChange). */
  undo(): void;
  redo(): void;
  addNode(type: NodeType, position: Position): string | null;
  updateNode(id: string, fn: (node: GraphNode) => GraphNode): void;
  updateEdge(id: string, fn: (edge: GraphEdge) => GraphEdge): void;
  moveNodes(positions: ReadonlyMap<string, Position>): void;
  /** Re-lays out every node with the layered top-to-bottom layout (§19.3). */
  autoLayout(): void;
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
  /** Resolves `externalChange` by keeping the local edits (the next autosave overwrites the file, without baseHash). */
  keepLocalChanges(): void;
  /** Saves `externalUndo.previous` back (with the current hash as baseHash) and shows it. */
  undoExternalChange(): Promise<void>;
  dismissExternalUndo(): void;
  setActiveRunId(runId: string | null): void;
}

export interface ExternalUndo {
  graphId: string;
  previous: Graph;
}

export const AUTOSAVE_DELAY_MS = 500;
/** Maximum number of undo steps kept per graph. */
export const HISTORY_LIMIT = 100;
/** Edits with the same coalesce key closer than this share one undo step. */
export const HISTORY_COALESCE_MS = 1000;
/** How long nodes changed outside the editor stay highlighted. */
export const HIGHLIGHT_MS = 4000;

export interface EditorPersistence {
  load(id: string): Promise<GetGraphResponse>;
  /** `baseHash`: refuse (409) when the file no longer has this hash. */
  save(graph: Graph, baseHash?: string): Promise<SaveGraphResponse>;
}

let persistence: EditorPersistence = { load: (id) => api.getGraph(id), save: (g, baseHash) => api.saveGraph(g, baseHash) };

/** Test seam. */
export function setEditorPersistence(p: EditorPersistence): void {
  persistence = p;
}

const EMPTY_VALIDATION: ValidationResult = { errors: [], warnings: [] };

export function isReadOnly(s: Pick<EditorStore, "graph" | "activeRunId" | "loadError">): boolean {
  return !s.graph || s.activeRunId !== null || s.loadError !== null;
}

type HistoryView = Pick<EditorStore, "graph" | "activeRunId" | "loadError" | "externalUndo" | "saving" | "past" | "future">;

/** The external change shown in the banner can be undone now. */
export function canUndoExternal(s: HistoryView): boolean {
  return !isReadOnly(s) && s.externalUndo !== null && s.externalUndo.graphId === s.graph?.id && !s.saving;
}

export function canUndo(s: HistoryView): boolean {
  return canUndoExternal(s) || (!isReadOnly(s) && s.past.length > 0);
}

export function canRedo(s: HistoryView): boolean {
  return !isReadOnly(s) && s.future.length > 0;
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
/**
 * A `graphs:changed` for this graph arrived while a save was pending or in flight and was not checked: it is
 * checked once the save settles, so a change saved meanwhile (e.g. Claude's patch_graph) is never missed.
 */
let recheckGraphId: string | null = null;
/** The user chose to keep the local edits over a conflicting file: the next save goes without baseHash. */
let overwriteOnce = false;

function clearSaveTimer(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

/** Key and time of the last edit, to merge the next one with the same key into its undo step. */
let lastEdit: { key: string; at: number } | null = null;

function clearHighlightTimer(): void {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = null;
}

/** JSON with object keys sorted, so two equal values compare equal whatever order their keys were built in. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Ids of nodes of `next` that are new or differ from `prev` (position changes included; key order ignored). Pure. */
export function changedNodeIds(prev: Graph, next: Graph): string[] {
  const before = new Map(prev.nodes.map((n) => [n.id, stableStringify(n)]));
  return next.nodes.filter((n) => before.get(n.id) !== stableStringify(n)).map((n) => n.id);
}

const NO_UNDO = { externalUndo: null, highlightNodeIds: [] };

const NO_HISTORY = { past: [], future: [] };

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
    const { graph, dirty, graphHash, externalChange } = get();
    // A conflict is open: nothing is saved until the user reloads or keeps the local edits.
    if (!graph || !dirty || externalChange) return;
    // baseHash: a change saved meanwhile by someone else (chat, MCP) is refused (409) instead of overwritten.
    const baseHash = overwriteOnce ? undefined : (graphHash ?? undefined);
    overwriteOnce = false;
    set({ saving: true });
    inflight = (async () => {
      try {
        const res = await persistence.save(graph, baseHash);
        const cur = get();
        if (cur.graph?.id !== graph.id) return;
        set(cur.graph === graph ? { dirty: false, graphHash: res.hash, saveError: null } : { graphHash: res.hash, saveError: null });
      } catch (err) {
        if (get().graph?.id !== graph.id) return;
        if (isConflict(err)) {
          // The file changed since the editor read it: same banner as a change seen while dirty.
          set({ externalChange: true, saveError: null });
        } else if (err instanceof ApiRequestError && err.body.code === "run_active") {
          set({ saveError: RUN_ACTIVE_MESSAGE });
        } else {
          set({ saveError: `Save failed: ${errorMessage(err)}` });
        }
      } finally {
        set({ saving: false });
        inflight = null;
      }
    })();
    await inflight;
    runPendingRecheck();
  }

  /** Runs the external-change check skipped while saving, once nothing is pending. */
  function runPendingRecheck(): void {
    const id = recheckGraphId;
    if (!id || saveTimer || inflight || get().saving) return;
    recheckGraphId = null;
    void get().checkExternalChange(id);
  }

  function applyLoaded(res: GetGraphResponse, keepSelection: boolean): void {
    overwriteOnce = false;
    lastEdit = null;
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
      ...NO_HISTORY,
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
    externalUndo: null,
    highlightNodeIds: [],
    past: [],
    future: [],

    setPhase(phase, supportedNodeTypes = null) {
      set({ phase, supportedNodeTypes, validation: validate(get().graph, { phase, supportedNodeTypes }) });
    },

    async openGraph(id) {
      await get().flushSave();
      clearSaveTimer();
      clearHighlightTimer();
      recheckGraphId = null;
      lastEdit = null;
      set({ ...NO_UNDO, ...NO_HISTORY, graphId: id, loading: true, loadError: null, graph: null, graphHash: null, dirty: false, validation: EMPTY_VALIDATION, ...NO_SELECTION });
      try {
        const res = await persistence.load(id);
        applyLoaded(res, false);
      } catch (err) {
        set({ loading: false, loadError: errorMessage(err), activeRunId: null, modifiedOutside: false });
      }
    },

    closeGraph() {
      clearSaveTimer();
      clearHighlightTimer();
      recheckGraphId = null;
      overwriteOnce = false;
      lastEdit = null;
      set({
        ...NO_UNDO,
        ...NO_HISTORY,
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

    edit(fn, coalesceKey) {
      const s = get();
      if (isReadOnly(s) || !s.graph) return;
      const next = fn(s.graph);
      if (next === s.graph) return;
      const now = Date.now();
      const merge = coalesceKey !== undefined && lastEdit?.key === coalesceKey && now - lastEdit.at < HISTORY_COALESCE_MS && s.past.length > 0;
      lastEdit = coalesceKey === undefined ? null : { key: coalesceKey, at: now };
      const past = merge ? s.past : [...s.past, s.graph].slice(-HISTORY_LIMIT);
      // Undoing an external change after local edits would silently discard them.
      set({ graph: next, dirty: true, validation: validate(next, s), ...pruneSelection(s, next), externalUndo: null, past, future: [] });
      scheduleSave();
    },

    undo() {
      const s = get();
      // An external change clears the local history when it is loaded, so it is always the most recent step.
      if (canUndoExternal(s)) {
        void s.undoExternalChange();
        return;
      }
      const prev = s.past.at(-1);
      if (isReadOnly(s) || !s.graph || !prev) return;
      lastEdit = null;
      set({ graph: prev, dirty: true, validation: validate(prev, s), ...pruneSelection(s, prev), past: s.past.slice(0, -1), future: [s.graph, ...s.future] });
      scheduleSave();
    },

    redo() {
      const s = get();
      const [next, ...future] = s.future;
      if (isReadOnly(s) || !s.graph || !next) return;
      lastEdit = null;
      set({ graph: next, dirty: true, validation: validate(next, s), ...pruneSelection(s, next), past: [...s.past, s.graph].slice(-HISTORY_LIMIT), future });
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
      get().edit((g) => ops.updateNode(g, id, fn), `node:${id}`);
    },

    updateEdge(id, fn) {
      get().edit((g) => ops.updateEdge(g, id, fn), `edge:${id}`);
    },

    moveNodes(positions) {
      get().edit((g) => ops.moveNodes(g, positions), `move:${[...positions.keys()].sort().join(",")}`);
    },

    autoLayout() {
      get().edit((g) => ops.moveNodes(g, layeredLayout(g)));
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
      }, "settings");
    },

    rename(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      get().edit((g) => (g.name === trimmed ? g : { ...g, name: trimmed }), "rename");
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
      if (s.graph?.id !== graphId) return;
      if (s.saving || saveTimer) {
        recheckGraphId = graphId;
        return;
      }
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
      if (cur.graph?.id !== graphId) return;
      if (cur.saving || saveTimer) {
        recheckGraphId = graphId;
        return;
      }
      if (res.hash === cur.graphHash) {
        set({ activeRunId: res.activeRunId });
        return;
      }
      if (cur.dirty) {
        set({ externalChange: true, activeRunId: res.activeRunId });
        return;
      }
      const previous = cur.graph;
      applyLoaded(res, true);
      const highlightNodeIds = changedNodeIds(previous, res.graph);
      // Keep the oldest version across consecutive external changes (one chat turn may save several times).
      const prevUndo = cur.externalUndo?.graphId === graphId ? cur.externalUndo : null;
      set({ externalUndo: prevUndo ?? { graphId, previous }, highlightNodeIds });
      clearHighlightTimer();
      if (highlightNodeIds.length) {
        highlightTimer = setTimeout(() => {
          highlightTimer = null;
          set({ highlightNodeIds: [] });
        }, HIGHLIGHT_MS);
      }
    },

    async reloadFromDisk() {
      const id = get().graph?.id;
      if (!id) return;
      clearSaveTimer();
      set(NO_UNDO);
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
      if (!get().externalChange) return;
      overwriteOnce = true;
      set({ externalChange: false });
      if (get().dirty && !saveTimer) scheduleSave();
    },

    async undoExternalChange() {
      const s = get();
      const undo = s.externalUndo;
      if (!undo || s.graph?.id !== undo.graphId || isReadOnly(s) || s.saving) return;
      clearSaveTimer();
      clearHighlightTimer();
      set({ saving: true });
      let failure: string | null = null;
      try {
        const res = await persistence.save(undo.previous, s.graphHash ?? undefined);
        if (get().graph?.id !== undo.graphId) return;
        lastEdit = null;
        set({
          ...NO_UNDO,
          ...NO_HISTORY,
          graph: res.graph,
          graphHash: res.hash,
          dirty: false,
          saveError: null,
          validation: validate(res.graph, get()),
          ...pruneSelection(get(), res.graph),
        });
      } catch (err) {
        if (get().graph?.id !== undo.graphId) return;
        failure = isConflict(err)
          ? "Undo failed: the graph changed again in the meantime."
          : err instanceof ApiRequestError && err.body.code === "run_active"
            ? `Undo failed: ${RUN_ACTIVE_MESSAGE}`
            : `Undo failed: ${errorMessage(err)}`;
        set({ ...NO_UNDO, saveError: failure });
      } finally {
        set({ saving: false });
      }
      if (failure === null) {
        runPendingRecheck();
        return;
      }
      // The shown graph and hash may be stale now (the change that made the undo fail was not loaded):
      // reload what is on disk so the next edit does not write the stale version back.
      recheckGraphId = null;
      await get().checkExternalChange(undo.graphId);
      if (get().graph?.id === undo.graphId) set({ saveError: failure });
    },

    dismissExternalUndo() {
      clearHighlightTimer();
      set(NO_UNDO);
    },

    setActiveRunId(runId) {
      set({ activeRunId: runId });
    },
  };
});

const RUN_ACTIVE_MESSAGE = "A run is active: changes cannot be saved until it finishes.";

function isConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.body.code === GRAPH_CONFLICT_CODE;
}

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
