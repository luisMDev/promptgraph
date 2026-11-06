import type { GetGraphResponse, Graph, SaveGraphResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf, linearGraph } from "../test-fixtures";
import { AUTOSAVE_DELAY_MS, HISTORY_COALESCE_MS, HISTORY_LIMIT, canRedo, canUndo, setEditorPersistence, useEditorStore } from "./editor-store";

function loaded(graph: Graph, hash: string, extra: Partial<GetGraphResponse> = {}): GetGraphResponse {
  return { graph, hash, modifiedOutside: false, activeRunId: null, ...extra };
}

const editor = () => useEditorStore.getState();

describe("editor store: undo / redo", () => {
  let disk: GetGraphResponse;
  const save = vi.fn(async (graph: Graph, _baseHash?: string): Promise<SaveGraphResponse> => ({ graph, hash: `saved-${save.mock.calls.length}` }));

  beforeEach(async () => {
    vi.useFakeTimers();
    save.mockClear();
    disk = loaded(linearGraph(), "h0");
    setEditorPersistence({ load: async () => disk, save });
    editor().closeGraph();
    editor().setPhase(1);
    await editor().openGraph("g1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with nothing to undo or redo", () => {
    expect(canUndo(editor())).toBe(false);
    expect(canRedo(editor())).toBe(false);
  });

  it("undoes and redoes edits in order, and autosaves the result", async () => {
    editor().rename("One");
    vi.advanceTimersByTime(HISTORY_COALESCE_MS);
    editor().addNode("commit", { x: 600, y: 0 });
    expect(editor().past).toHaveLength(2);

    editor().undo();
    expect(editor().graph?.nodes).toHaveLength(2);
    expect(editor().graph?.name).toBe("One");
    expect(canRedo(editor())).toBe(true);

    editor().undo();
    expect(editor().graph?.name).toBe(linearGraph().name);
    expect(canUndo(editor())).toBe(false);

    editor().redo();
    editor().redo();
    expect(editor().graph?.name).toBe("One");
    expect(editor().graph?.nodes).toHaveLength(3);
    expect(canRedo(editor())).toBe(false);

    save.mockClear();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].nodes).toHaveLength(3);
  });

  it("a new edit after an undo drops the redo steps", () => {
    editor().rename("One");
    editor().undo();
    editor().addNode("commit", { x: 600, y: 0 });
    expect(canRedo(editor())).toBe(false);
  });

  it("merges a drag or typing in one field into one undo step", () => {
    for (let x = 0; x < 5; x++) editor().moveNodes(new Map([["a", { x: x * 16, y: 0 }]]));
    for (const label of ["P", "Pl", "Pla", "Plan"]) editor().updateNode("b", (n) => ({ ...n, label }));
    expect(editor().past).toHaveLength(2);
    editor().undo();
    expect(editor().graph?.nodes.find((n) => n.id === "b")?.label).toBe(linearGraph().nodes[1]!.label);
    editor().undo();
    expect(editor().graph?.nodes.find((n) => n.id === "a")?.position).toEqual(linearGraph().nodes[0]!.position);
  });

  it("does not merge edits of the same field once the coalesce window has passed", () => {
    editor().updateNode("b", (n) => ({ ...n, label: "X" }));
    vi.advanceTimersByTime(HISTORY_COALESCE_MS);
    editor().updateNode("b", (n) => ({ ...n, label: "Y" }));
    expect(editor().past).toHaveLength(2);
  });

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      editor().rename(`Name ${i}`);
      vi.advanceTimersByTime(HISTORY_COALESCE_MS);
    }
    expect(editor().past).toHaveLength(HISTORY_LIMIT);
  });

  it("is disabled while the graph is read-only", () => {
    editor().rename("One");
    editor().setActiveRunId("r1");
    expect(canUndo(editor())).toBe(false);
    editor().undo();
    expect(editor().graph?.name).toBe("One");
  });

  it("clears the history when the graph is reloaded or another graph opens", async () => {
    editor().rename("One");
    await editor().flushSave();
    disk = loaded(graphOf({ name: "Theirs" }), "h-other");
    await editor().checkExternalChange("g1");
    expect(editor().past).toEqual([]);
    expect(editor().future).toEqual([]);

    editor().rename("Two");
    await editor().openGraph("g1");
    expect(editor().past).toEqual([]);
  });

  it("undoes an external change that came after the local edits", async () => {
    editor().rename("Mine");
    await editor().flushSave();
    disk = loaded(graphOf({ name: "Theirs" }), "h-other");
    await editor().checkExternalChange("g1");
    expect(canUndo(editor())).toBe(true);

    editor().undo();
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Mine" }), "h-other");
    expect(editor().graph?.name).toBe("Mine");
    expect(editor().externalUndo).toBeNull();
  });
});
