// @vitest-environment jsdom
import type { Graph, SaveGraphResponse } from "@promptgraph/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf, linearGraph } from "../../test-fixtures";
import { setEditorPersistence, useEditorStore } from "../../store/editor-store";
import { Banners } from "./Banners";

describe("Banners: graph updated outside the editor", () => {
  const save = vi.fn(async (graph: Graph, _baseHash?: string): Promise<SaveGraphResponse> => ({ graph, hash: "h2" }));
  let disk = { graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null as string | null };

  beforeEach(async () => {
    save.mockClear();
    disk = { graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null };
    setEditorPersistence({ load: async () => disk, save });
    useEditorStore.getState().closeGraph();
    await useEditorStore.getState().openGraph("g1");
    disk = { ...disk, graph: graphOf({ ...linearGraph(), name: "Changed by Claude" }), hash: "h1" };
    await useEditorStore.getState().checkExternalChange("g1");
  });
  afterEach(cleanup);

  it("offers Undo, which saves the previous version back", async () => {
    const user = userEvent.setup();
    render(<Banners />);
    expect(screen.getByText(/Graph updated outside the editor/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].name).toBe("Graph 1");
    expect(save.mock.calls[0]![1]).toBe("h1");
    await waitFor(() => expect(screen.queryByText(/Graph updated outside the editor/)).toBeNull());
    expect(useEditorStore.getState().graph?.name).toBe("Graph 1");
  });

  it("can be dismissed", async () => {
    const user = userEvent.setup();
    render(<Banners />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Graph updated outside the editor/)).toBeNull();
    expect(useEditorStore.getState().graph?.name).toBe("Changed by Claude");
    expect(save).not.toHaveBeenCalled();
  });
});
