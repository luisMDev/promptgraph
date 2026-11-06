// @vitest-environment jsdom
import type { Graph, SaveGraphResponse } from "@promptgraph/shared";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf, linearGraph } from "../../test-fixtures";
import { createTestView, type TestView } from "../../store/view/test-view";
import { Banners } from "./Banners";

describe("Banners: graph updated outside the editor", () => {
  const save = vi.fn(async (graph: Graph, _baseHash?: string): Promise<SaveGraphResponse> => ({ graph, hash: "h2" }));
  let disk = { graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null as string | null };
  let view: TestView;

  beforeEach(async () => {
    save.mockClear();
    disk = { graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null };
    view = createTestView({ graphId: "g1", persistence: { load: async () => disk, save } });
    await view.editor.getState().load();
    disk = { ...disk, graph: graphOf({ ...linearGraph(), name: "Changed by Claude" }), hash: "h1" };
    await view.editor.getState().checkExternalChange();
  });
  afterEach(cleanup);

  it("offers Undo, which saves the previous version back", async () => {
    const user = userEvent.setup();
    view.render(<Banners />);
    expect(screen.getByText(/Graph updated outside the editor/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].name).toBe("Graph 1");
    expect(save.mock.calls[0]![1]).toBe("h1");
    await waitFor(() => expect(screen.queryByText(/Graph updated outside the editor/)).toBeNull());
    expect(view.editor.getState().graph?.name).toBe("Graph 1");
  });

  it("can be dismissed", async () => {
    const user = userEvent.setup();
    view.render(<Banners />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Graph updated outside the editor/)).toBeNull();
    expect(view.editor.getState().graph?.name).toBe("Changed by Claude");
    expect(save).not.toHaveBeenCalled();
  });
});
