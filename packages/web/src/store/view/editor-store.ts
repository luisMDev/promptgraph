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
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiRequestError, errorMessage, repoApi } from "../../api/rest";
import * as ops from "../../lib/graph-ops";

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

/** Validation options of the daemon (DaemonInfoResponse.phase / supportedNodeTypes). */
export interface EditorValidation {
  phase: 1 | 2;
  /** null = all. */
  supportedNodeTypes: readonly NodeType[] | null;
}

/**
 * Extensions over the contract interface (see CONTRACTS.md §9 notes). One store per `(repoId, graphId)`,
 * shared by every view of that graph (`acquireEditorStore`), so two views never autosave over each other.
 */
export interface EditorStore extends EditorState, EditorValidation {
  repoId: string;
  /** The graph of this store (fixed); null for the empty store of a view that shows no graph. */
  graphId: string | null;
  loading: boolean;
  /** Graph file failed to load (parse/zod error) or was deleted. */
  loadError: string | null;
  /** The graph does not exist (404): the view shows "not found". */
  notFound: boolean;
  saveError: string | null;
  /** A run of this graph is active: the graph is read-only. */
  activeRunId: string | null;
  /** The file changed on disk while there were unsaved local edits. */
  externalChange: boolean;
  /** Multi-selection; selectedNodeId/selectedEdgeId are set only when exactly one element is selected. */
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  /** Discarded (graph deleted, repository removed): no more saves. */
  discarded: boolean;
  /**
   * The graph was reloaded because it changed outside the editor (chat, MCP, another tool): the version shown
   * before, which "Undo" saves back. Cleared by a local edit, a reload or a dismiss.
   */
  externalUndo: ExternalUndo | null;
  /** Nodes added or changed by the last external change; highlighted on the canvas for HIGHLIGHT_MS. */
  highlightNodeIds: string[];
  /**
   * Local edit history of the graph, oldest first (at most HISTORY_LIMIT entries). Cleared whenever the graph is
   * (re)loaded from disk, so a version older than the file is never written back silently.
   */
  past: Graph[];
  /** Versions undone since the last edit, the next one to redo first. */
  future: Graph[];

  setPhase(phase: 1 | 2, supportedNodeTypes?: readonly NodeType[] | null): void;
  /** (Re)loads the graph file. */
  load(): Promise<void>;
  /**
   * Applies an edit (no-op while read-only); marks dirty, revalidates, records an undo step and schedules the
   * autosave. Consecutive edits with the same `coalesceKey` less than HISTORY_COALESCE_MS apart (a drag, typing
   * in a field) share one undo step.
   */
  edit(fn: (graph: Graph) => Graph, coalesceKey?: string): void;
  /** Reverts the last local edit, or the external change shown in the banner (see undoExternalChange). */
  undo(): void;
  /** Re-applies the last undone local edit. */
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
  /** Writes a pending autosave now (and waits for one in flight). */
  flushSave(): Promise<void>;
  /** Called on `graphs:changed`: reloads a file changed outside the app, or flags a conflict when dirty. */
  checkExternalChange(): Promise<void>;
  reloadFromDisk(): Promise<void>;
  dismissModifiedOutside(): void;
  /** Resolves `externalChange` by keeping the local edits (the next autosave overwrites the file, without baseHash). */
  keepLocalChanges(): void;
  /** Saves `externalUndo.previous` back (with the current hash as baseHash) and shows it. */
  undoExternalChange(): Promise<void>;
  dismissExternalUndo(): void;
  setActiveRunId(runId: string | null): void;
  /** Drops pending edits and stops saving. Returns whether unsaved edits were lost. */
  discard(): boolean;
}

export type EditorStoreApi = StoreApi<EditorStore>;

export interface ExternalUndo {
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
  /** `baseHash`: refuse (409 graph_conflict) when the file no longer has this hash. */
  save(graph: Graph, baseHash?: string): Promise<SaveGraphResponse>;
}

export function repoPersistence(repoId: string): EditorPersistence {
  const api = repoApi(repoId);
  return { load: (id) => api.getGraph(id), save: (g, baseHash) => api.saveGraph(g, baseHash) };
}

const EMPTY_VALIDATION: ValidationResult = { errors: [], warnings: [] };
const DEFAULT_VALIDATION: EditorValidation = { phase: 1, supportedNodeTypes: null };

export function isReadOnly(s: Pick<EditorStore, "graph" | "activeRunId" | "loadError">): boolean {
  return !s.graph || s.activeRunId !== null || s.loadError !== null;
}

type HistoryView = Pick<EditorStore, "graph" | "activeRunId" | "loadError" | "discarded" | "externalUndo" | "saving" | "past" | "future">;

/** The external change shown in the banner can be undone now. */
export function canUndoExternal(s: HistoryView): boolean {
  return !isReadOnly(s) && !s.discarded && s.externalUndo !== null && !s.saving;
}

export function canUndo(s: HistoryView): boolean {
  return canUndoExternal(s) || (!isReadOnly(s) && !s.discarded && s.past.length > 0);
}

export function canRedo(s: HistoryView): boolean {
  return !isReadOnly(s) && !s.discarded && s.future.length > 0;
}

function validate(graph: Graph | null, s: EditorValidation): ValidationResult {
  if (!graph) return EMPTY_VALIDATION;
  try {
    return validateGraph(graph, { phase: s.phase, ...(s.supportedNodeTypes ? { supportedNodeTypes: s.supportedNodeTypes } : {}) });
  } catch (err) {
    return { errors: [{ code: "invalid_config", message: `Validator crashed: ${errorMessage(err)}` }], warnings: [] };
  }
}

const NO_SELECTION = { selectedNodeIds: [], selectedEdgeIds: [], selectedNodeId: null, selectedEdgeId: null };
const NO_UNDO = { externalUndo: null, highlightNodeIds: [] };
const NO_HISTORY = { past: [], future: [] };
const RUN_ACTIVE_MESSAGE = "A run is active: changes cannot be saved until it finishes.";

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

function isConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.body.code === GRAPH_CONFLICT_CODE;
}

export interface CreateEditorOptions {
  persistence?: EditorPersistence;
  validation?: EditorValidation;
}

/**
 * The editor store of one graph (not cached: views use `acquireEditorStore`). `graphId` null gives the
 * inert store of a view without a graph. The autosave timer, the in-flight save, the pending external-change
 * recheck and the highlight timer belong to the instance.
 */
export function createEditorStore(repoId: string, graphId: string | null, opts: CreateEditorOptions = {}): EditorStoreApi {
  const persistence = opts.persistence ?? repoPersistence(repoId);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  /**
   * A `graphs:changed` arrived while a save was pending or in flight and was not checked: it is checked once the
   * save settles, so a change saved meanwhile (e.g. Claude's patch_graph) is never missed.
   */
  let recheckPending = false;
  /** The user chose to keep the local edits over a conflicting file: the next save goes without baseHash. */
  let overwriteOnce = false;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Key and time of the last edit, to merge the next one with the same key into its undo step. */
  let lastEdit: { key: string; at: number } | null = null;

  function clearSaveTimer(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  }

  function clearHighlightTimer(): void {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = null;
  }

  return createStore<EditorStore>()((set, get) => {
    function scheduleSave(): void {
      clearSaveTimer();
      if (get().discarded) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void runSave();
      }, AUTOSAVE_DELAY_MS);
    }

    async function runSave(): Promise<void> {
      if (inflight) {
        await inflight;
        if (get().dirty && !saveTimer && !get().discarded) return runSave();
        return;
      }
      const { graph, dirty, discarded, graphHash, externalChange } = get();
      // A conflict is open: nothing is saved until the user reloads or keeps the local edits.
      if (!graph || !dirty || discarded || externalChange) return;
      // baseHash: a change saved meanwhile by someone else (chat, MCP) is refused (409) instead of overwritten.
      const baseHash = overwriteOnce ? undefined : (graphHash ?? undefined);
      overwriteOnce = false;
      set({ saving: true });
      inflight = (async () => {
        try {
          const res = await persistence.save(graph, baseHash);
          const cur = get();
          if (cur.discarded) return;
          set(cur.graph === graph ? { dirty: false, graphHash: res.hash, saveError: null } : { graphHash: res.hash, saveError: null });
        } catch (err) {
          if (get().discarded) return;
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
      if (!recheckPending || saveTimer || inflight || get().saving) return;
      recheckPending = false;
      void get().checkExternalChange();
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
        notFound: false,
        saveError: null,
        externalChange: false,
        validation: validate(res.graph, get()),
        ...NO_HISTORY,
        ...selection,
      });
    }

    const v = opts.validation ?? DEFAULT_VALIDATION;
    return {
      repoId,
      graphId,
      graph: null,
      graphHash: null,
      modifiedOutside: false,
      dirty: false,
      saving: false,
      validation: EMPTY_VALIDATION,
      selectedNodeId: null,
      selectedEdgeId: null,
      phase: v.phase,
      supportedNodeTypes: v.supportedNodeTypes,
      loading: graphId !== null,
      loadError: null,
      notFound: false,
      saveError: null,
      activeRunId: null,
      externalChange: false,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      discarded: false,
      externalUndo: null,
      highlightNodeIds: [],
      past: [],
      future: [],

      setPhase(phase, supportedNodeTypes = null) {
        const s = get();
        if (s.phase === phase && s.supportedNodeTypes === supportedNodeTypes) return;
        set({ phase, supportedNodeTypes, validation: validate(s.graph, { phase, supportedNodeTypes }) });
      },

      async load() {
        if (!graphId) return;
        await get().flushSave();
        clearSaveTimer();
        clearHighlightTimer();
        recheckPending = false;
        lastEdit = null;
        set({ ...NO_UNDO, ...NO_HISTORY, loading: true, loadError: null, notFound: false, graph: null, graphHash: null, dirty: false, validation: EMPTY_VALIDATION, ...NO_SELECTION });
        try {
          const res = await persistence.load(graphId);
          if (!get().discarded) applyLoaded(res, false);
        } catch (err) {
          const notFound = err instanceof ApiRequestError && err.status === 404;
          set({ loading: false, loadError: errorMessage(err), notFound, activeRunId: null, modifiedOutside: false });
        }
      },

      edit(fn, coalesceKey) {
        const s = get();
        if (isReadOnly(s) || !s.graph || s.discarded) return;
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
        // Loading an external change clears the local history, so when there is one it is the latest step.
        if (canUndoExternal(s)) {
          void s.undoExternalChange();
          return;
        }
        const prev = s.past.at(-1);
        if (!canUndo(s) || !s.graph || !prev) return;
        lastEdit = null;
        set({ graph: prev, dirty: true, validation: validate(prev, s), ...pruneSelection(s, prev), past: s.past.slice(0, -1), future: [s.graph, ...s.future] });
        scheduleSave();
      },

      redo() {
        const s = get();
        const [next, ...future] = s.future;
        if (!canRedo(s) || !s.graph || !next) return;
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

      async checkExternalChange() {
        const s = get();
        if (!graphId || !s.graph || s.discarded) return;
        if (s.saving || saveTimer) {
          recheckPending = true;
          return;
        }
        let res: GetGraphResponse;
        try {
          res = await persistence.load(graphId);
        } catch (err) {
          if (err instanceof ApiRequestError && err.status === 404 && get().graph) {
            clearSaveTimer();
            set({ graph: null, graphHash: null, dirty: false, activeRunId: null, modifiedOutside: false, externalChange: false, validation: EMPTY_VALIDATION, ...NO_SELECTION, loadError: "This graph was deleted." });
          }
          return;
        }
        const cur = get();
        if (!cur.graph || cur.discarded) return;
        if (cur.saving || saveTimer) {
          recheckPending = true;
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
        set({ externalUndo: cur.externalUndo ?? { previous }, highlightNodeIds });
        clearHighlightTimer();
        if (highlightNodeIds.length) {
          highlightTimer = setTimeout(() => {
            highlightTimer = null;
            set({ highlightNodeIds: [] });
          }, HIGHLIGHT_MS);
        }
      },

      async reloadFromDisk() {
        if (!graphId || !get().graph) return;
        clearSaveTimer();
        set(NO_UNDO);
        try {
          applyLoaded(await persistence.load(graphId), true);
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
        if (!undo || !s.graph || isReadOnly(s) || s.saving || s.discarded) return;
        clearSaveTimer();
        clearHighlightTimer();
        set({ saving: true });
        let failure: string | null = null;
        try {
          const res = await persistence.save(undo.previous, s.graphHash ?? undefined);
          if (get().discarded) return;
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
          if (get().discarded) return;
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
        recheckPending = false;
        await get().checkExternalChange();
        if (!get().discarded) set({ saveError: failure });
      },

      dismissExternalUndo() {
        clearHighlightTimer();
        set(NO_UNDO);
      },

      setActiveRunId(runId) {
        if (get().activeRunId !== runId) set({ activeRunId: runId });
      },

      discard() {
        const lost = get().dirty || saveTimer !== null;
        clearSaveTimer();
        clearHighlightTimer();
        set({ discarded: true });
        return lost;
      },
    };
  });
}

// --- Shared, reference-counted instances ----------------------------------------------------------------

interface Entry {
  store: EditorStoreApi;
  refs: number;
}

const editors = new Map<string, Entry>();

export function editorKey(repoId: string, graphId: string): string {
  return `${repoId}:${graphId}`;
}

export interface EditorHandle {
  store: EditorStoreApi;
  /** Releases this reference; the last release flushes the pending autosave, then disposes the store. */
  release(): Promise<void>;
}

/**
 * The editor store of `(repoId, graphId)`, shared by every view that shows that graph (DESIGN §13.4). The
 * first acquire creates and loads it.
 */
export function acquireEditorStore(repoId: string, graphId: string, opts: CreateEditorOptions = {}): EditorHandle {
  const key = editorKey(repoId, graphId);
  let entry = editors.get(key);
  if (!entry) {
    entry = { store: createEditorStore(repoId, graphId, opts), refs: 0 };
    editors.set(key, entry);
    void entry.store.getState().load();
  } else if (opts.validation) {
    entry.store.getState().setPhase(opts.validation.phase, opts.validation.supportedNodeTypes);
  }
  entry.refs++;
  const held = entry;
  let released = false;
  return {
    store: held.store,
    async release() {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs > 0) return;
      await held.store.getState().flushSave();
      // Acquired again while flushing: keep it.
      if (held.refs === 0 && editors.get(key) === held) editors.delete(key);
    },
  };
}

/** The shared editor store of a graph, when some view holds it. */
export function findEditorStore(repoId: string, graphId: string): EditorStoreApi | undefined {
  return editors.get(editorKey(repoId, graphId))?.store;
}

export function liveEditorStores(): EditorStoreApi[] {
  return [...editors.values()].map((e) => e.store);
}

/** `pagehide`: writes every pending autosave (closing the browser tab or the desktop window). */
export function flushAllEditors(): Promise<void> {
  return Promise.all(liveEditorStores().map((s) => s.getState().flushSave())).then(() => undefined);
}

/** Discards one shared store (graph deleted). Returns whether unsaved edits were lost. */
export function discardEditorStore(repoId: string, graphId: string): boolean {
  const key = editorKey(repoId, graphId);
  const entry = editors.get(key);
  if (!entry) return false;
  editors.delete(key);
  return entry.store.getState().discard();
}

/**
 * `repo:removed`: discards every editor store of the repository (a save would hit 404). Returns the
 * graph names whose unsaved edits were lost.
 */
export function discardEditorsOf(repoId: string): string[] {
  const lost: string[] = [];
  for (const [key, entry] of editors) {
    if (entry.store.getState().repoId !== repoId) continue;
    editors.delete(key);
    const s = entry.store.getState();
    if (s.discard()) lost.push(s.graph?.name ?? s.graphId ?? key);
  }
  return lost;
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
