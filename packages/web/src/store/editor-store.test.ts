import type { GetGraphResponse, Graph, SaveGraphResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf, linearGraph } from "../test-fixtures";
import { AUTOSAVE_DELAY_MS, setEditorPersistence, useEditorStore } from "./editor-store";

function loaded(graph: Graph, extra: Partial<GetGraphResponse> = {}): GetGraphResponse {
  return { graph, hash: "h0", modifiedOutside: false, activeRunId: null, ...extra };
}

describe("editor store", () => {
  let disk: GetGraphResponse;
  const save = vi.fn(async (graph: Graph): Promise<SaveGraphResponse> => ({ graph, hash: `h${save.mock.calls.length}` }));

  beforeEach(async () => {
    vi.useFakeTimers();
    save.mockClear();
    disk = loaded(linearGraph());
    setEditorPersistence({ load: async () => disk, save });
    useEditorStore.getState().closeGraph();
    useEditorStore.getState().setPhase(1);
    await useEditorStore.getState().openGraph("g1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads a graph and validates it", () => {
    const s = useEditorStore.getState();
    expect(s.graph?.nodes).toHaveLength(2);
    expect(s.graphHash).toBe("h0");
    expect(s.dirty).toBe(false);
    expect(s.validation.errors).toEqual([]);
  });

  it("debounces autosave to one PUT 500ms after the last edit", async () => {
    const s = useEditorStore.getState();
    s.rename("Renamed");
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100);
    s.updateNode("a", (n) => ({ ...n, label: "Plan" }));
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100);
    expect(save).not.toHaveBeenCalled();
    expect(useEditorStore.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]![0];
    expect(saved.name).toBe("Renamed");
    expect(saved.nodes[0]!.label).toBe("Plan");
    expect(useEditorStore.getState()).toMatchObject({ dirty: false, saving: false, graphHash: "h1" });
  });

  it("flushSave writes pending edits immediately", async () => {
    useEditorStore.getState().addNode("commit", { x: 600, y: 0 });
    await useEditorStore.getState().flushSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].nodes.map((n) => n.type)).toEqual(["prompt", "shell", "commit"]);
  });

  it("re-validates on edits and reports join errors", () => {
    const s = useEditorStore.getState();
    const id = s.addNode("prompt", { x: 600, y: 200 })!;
    expect(useEditorStore.getState().selectedNodeId).toBe(id);
    expect(s.connect({ source: id, sourcePort: "out", target: "b" })).toBeNull();
    const errors = useEditorStore.getState().validation.errors;
    expect(errors.some((e) => e.code === "invalid_join" && e.nodeId === "b")).toBe(true);
  });

  it("returns the refusal reason for invalid connections", () => {
    expect(useEditorStore.getState().connect({ source: "a", sourcePort: "out", target: "a" })).toMatch(/itself/);
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it("deletes the selection including connected edges and prunes the selection", () => {
    const s = useEditorStore.getState();
    s.setSelection(["a"], []);
    s.removeSelection();
    const after = useEditorStore.getState();
    expect(after.graph?.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(after.graph?.edges).toEqual([]);
    expect(after.selectedNodeIds).toEqual([]);
  });

  it("is read-only while a run is active", async () => {
    disk = loaded(linearGraph(), { activeRunId: "r1" });
    await useEditorStore.getState().openGraph("g1");
    useEditorStore.getState().rename("Nope");
    expect(useEditorStore.getState().addNode("shell", { x: 0, y: 0 })).toBeNull();
    expect(useEditorStore.getState().graph?.name).toBe("Graph 1");
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it("reloads a file changed on disk, or flags a conflict when there are local edits", async () => {
    disk = loaded(graphOf({ name: "From disk" }), { hash: "h-disk", modifiedOutside: true });
    await useEditorStore.getState().checkExternalChange("g1");
    expect(useEditorStore.getState()).toMatchObject({ graphHash: "h-disk", modifiedOutside: true, externalChange: false });
    expect(useEditorStore.getState().graph?.name).toBe("From disk");

    useEditorStore.getState().rename("Mine");
    await useEditorStore.getState().flushSave();
    useEditorStore.getState().rename("Mine again");
    vi.clearAllTimers();
    useEditorStore.setState({ saving: false });
    disk = loaded(graphOf({ name: "Theirs" }), { hash: "h-other" });
    // A pending autosave means the change is probably ours: no reload.
    await useEditorStore.getState().checkExternalChange("g1");
    expect(useEditorStore.getState().graph?.name).toBe("Mine again");
  });

  it("does not overwrite local edits when the file changes", async () => {
    useEditorStore.getState().rename("Local");
    await useEditorStore.getState().flushSave();
    useEditorStore.setState({ dirty: true });
    disk = loaded(graphOf({ name: "Remote" }), { hash: "h-remote" });
    await useEditorStore.getState().checkExternalChange("g1");
    expect(useEditorStore.getState()).toMatchObject({ externalChange: true });
    expect(useEditorStore.getState().graph?.name).toBe("Local");
  });

  it("surfaces save failures and retries on the next edit", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    useEditorStore.getState().rename("X");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(useEditorStore.getState().saveError).toMatch(/disk full/);
    expect(useEditorStore.getState().dirty).toBe(true);
    useEditorStore.getState().rename("Y");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(useEditorStore.getState()).toMatchObject({ saveError: null, dirty: false });
  });
});
