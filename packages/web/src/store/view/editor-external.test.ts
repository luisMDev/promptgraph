import { GRAPH_CONFLICT_CODE, type GetGraphResponse, type Graph, type SaveGraphResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/rest";
import { graphOf, linearGraph } from "../../test-fixtures";
import { AUTOSAVE_DELAY_MS, HIGHLIGHT_MS, changedNodeIds, createEditorStore, type EditorStoreApi } from "./editor-store";
import { TEST_REPO_ID } from "./test-view";

function loaded(graph: Graph, hash: string, extra: Partial<GetGraphResponse> = {}): GetGraphResponse {
  return { graph, hash, modifiedOutside: false, activeRunId: null, ...extra };
}

/** The linear graph after a chat turn: "b" changed, "c" added after it. */
function patchedGraph(): Graph {
  const g = linearGraph();
  return graphOf({
    nodes: [
      g.nodes[0]!,
      { ...g.nodes[1]!, label: "Unit tests" },
      { id: "c", type: "commit", label: "Commit", position: { x: 600, y: 0 }, config: {} },
    ],
    edges: [...g.edges, { id: "e2", source: "b", target: "c" }],
  });
}

describe("editor store: changes made outside the editor", () => {
  let disk: GetGraphResponse;
  let store: EditorStoreApi;
  const save = vi.fn(async (graph: Graph, _baseHash?: string): Promise<SaveGraphResponse> => ({ graph, hash: `saved-${save.mock.calls.length}` }));

  beforeEach(async () => {
    vi.useFakeTimers();
    save.mockClear();
    disk = loaded(linearGraph(), "h0");
    store = createEditorStore(TEST_REPO_ID, "g1", { persistence: { load: async () => disk, save } });
    await store.getState().load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists added and changed nodes", () => {
    expect(changedNodeIds(linearGraph(), patchedGraph())).toEqual(["b", "c"]);
    expect(changedNodeIds(linearGraph(), linearGraph())).toEqual([]);
  });

  it("keeps the previous version and highlights the changed nodes for a few seconds", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    const s = store.getState();
    expect(s.graph?.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(s.externalUndo?.previous.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(s.highlightNodeIds).toEqual(["b", "c"]);

    vi.advanceTimersByTime(HIGHLIGHT_MS);
    expect(store.getState().highlightNodeIds).toEqual([]);
    // The undo stays available after the highlight fades.
    expect(store.getState().externalUndo).not.toBeNull();
  });

  it("Undo saves the previous version back with the current hash as baseHash", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    await store.getState().undoExternalChange();
    expect(save).toHaveBeenCalledTimes(1);
    const [graph, baseHash] = save.mock.calls[0]!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(baseHash).toBe("h1");
    const s = store.getState();
    expect(s).toMatchObject({ externalUndo: null, highlightNodeIds: [], dirty: false, graphHash: "saved-1", saveError: null });
    expect(s.graph?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("keeps the oldest version across consecutive external changes", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    disk = loaded(graphOf({ ...patchedGraph(), name: "Renamed by Claude" }), "h2");
    await store.getState().checkExternalChange();
    expect(store.getState().externalUndo?.previous.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("drops the undo on a local edit, a dismiss or a reload", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    store.getState().rename("Mine");
    expect(store.getState().externalUndo).toBeNull();

    await store.getState().flushSave();
    disk = loaded(linearGraph(), "h3");
    await store.getState().checkExternalChange();
    expect(store.getState().externalUndo).not.toBeNull();
    store.getState().dismissExternalUndo();
    expect(store.getState()).toMatchObject({ externalUndo: null, highlightNodeIds: [] });

    disk = loaded(patchedGraph(), "h4");
    await store.getState().checkExternalChange();
    await store.getState().load();
    expect(store.getState().externalUndo).toBeNull();
  });

  it("reports a conflict when the graph changed again before Undo", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    save.mockRejectedValueOnce(new ApiRequestError(409, { error: "changed", code: GRAPH_CONFLICT_CODE }));
    await store.getState().undoExternalChange();
    const s = store.getState();
    expect(s.saveError).toMatch(/changed again/);
    expect(s.externalUndo).toBeNull();
    expect(s.graph?.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("reloads the graph on disk when Undo hits a conflict, so the stale version is never written back", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    // Claude saves again while the Undo PUT is in flight.
    const newer = graphOf({ ...patchedGraph(), name: "Newer" });
    save.mockImplementationOnce(async () => {
      disk = loaded(newer, "h2");
      throw new ApiRequestError(409, { error: "changed", code: GRAPH_CONFLICT_CODE });
    });
    await store.getState().undoExternalChange();
    const s = store.getState();
    expect(s).toMatchObject({ graphHash: "h2", dirty: false });
    expect(s.graph?.name).toBe("Newer");
    expect(s.saveError).toMatch(/changed again/);
  });

  it("reports a run lock on Undo as such, not as a conflict", async () => {
    disk = loaded(patchedGraph(), "h1");
    await store.getState().checkExternalChange();
    save.mockRejectedValueOnce(new ApiRequestError(409, { error: "Graph is locked by an active run", code: "run_active" }));
    await store.getState().undoExternalChange();
    expect(store.getState().saveError).toMatch(/A run is active/);
    expect(store.getState().saveError).not.toMatch(/changed again/);
  });

  it("ignores key order when listing changed nodes", () => {
    const prev = linearGraph();
    const reordered = graphOf({
      ...prev,
      nodes: prev.nodes.map((n) => {
        const { config, position, label, type, id, ...rest } = n;
        return { config: { ...config }, position: { y: position.y, x: position.x }, label, type, id, ...rest } as typeof n;
      }),
    });
    expect(changedNodeIds(prev, reordered)).toEqual([]);
  });

  it("does not offer an undo for a reload over a dirty graph", async () => {
    store.getState().rename("Local");
    disk = loaded(patchedGraph(), "h1");
    vi.clearAllTimers();
    await store.getState().flushSave();
    store.setState({ dirty: true });
    await store.getState().checkExternalChange();
    expect(store.getState()).toMatchObject({ externalChange: true, externalUndo: null });
  });
});

describe("editor store: autosave racing a change saved outside the editor", () => {
  let disk: GetGraphResponse;
  let store: EditorStoreApi;
  let n = 0;
  /** Like the server: a stale baseHash is refused with 409 graph_conflict. */
  const save = vi.fn(async (graph: Graph, baseHash?: string): Promise<SaveGraphResponse> => {
    if (baseHash !== undefined && baseHash !== disk.hash) throw new ApiRequestError(409, { error: "changed", code: GRAPH_CONFLICT_CODE });
    disk = loaded(graph, `saved-${++n}`);
    return { graph, hash: disk.hash };
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    save.mockClear();
    disk = loaded(linearGraph(), "h0");
    store = createEditorStore(TEST_REPO_ID, "g1", { persistence: { load: async () => disk, save } });
    await store.getState().load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("autosave sends the last known hash and turns a conflict into the external-change banner", async () => {
    store.getState().rename("Local");
    // Claude's patch_graph lands while the autosave timer is pending; its graphs:changed is skipped.
    disk = loaded(patchedGraph(), "h-claude");
    await store.getState().checkExternalChange();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toBe("h0");
    // Claude's version is still on disk; the local edits are kept and the conflict is shown.
    expect(disk.hash).toBe("h-claude");
    expect(store.getState()).toMatchObject({ externalChange: true, dirty: true });
    expect(store.getState().graph?.name).toBe("Local");

    // "Keep mine" overwrites on purpose: the next save goes without baseHash.
    store.getState().keepLocalChanges();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(save.mock.calls.at(-1)![1]).toBeUndefined();
    expect(store.getState()).toMatchObject({ externalChange: false, dirty: false });
    expect(disk.graph.name).toBe("Local");
  });

  it("re-checks a change skipped during an in-flight save once the save settles", async () => {
    let release!: () => void;
    save.mockImplementationOnce(async (graph: Graph) => {
      await new Promise<void>((r) => (release = r));
      disk = loaded(graph, "saved-own");
      const res = { graph, hash: disk.hash };
      // Claude saves right after us; its graphs:changed arrives while the save is still settling.
      disk = loaded(patchedGraph(), "h-claude");
      return res;
    });
    store.getState().rename("Local");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(store.getState().saving).toBe(true);
    await store.getState().checkExternalChange();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getState().graphHash).toBe("h-claude"));
    const s = store.getState();
    expect(s.graph?.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(s.externalUndo?.previous.name).toBe("Local");
  });
});
