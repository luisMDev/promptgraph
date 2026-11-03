// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestView } from "../../store/view/test-view";
import { linearGraph } from "../../test-fixtures";
import { Canvas } from "./Canvas";

const graph = linearGraph();

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function renderCanvas(active: boolean) {
  const view = createTestView({ graphId: "g1", active });
  view.editor.setState({ graph, graphHash: "h0", loading: false });
  view.render(<Canvas />);
  act(() => view.editor.getState().setSelection(["a"], []));
  return view;
}

describe("canvas in a hidden tab (DESIGN §13.4)", () => {
  it("the visible view deletes the selection on Backspace", async () => {
    const view = renderCanvas(true);
    await screen.findByText("Implement");
    fireEvent.keyDown(document.body, { key: "Backspace", code: "Backspace" });
    // React Flow deletes asynchronously (onBeforeDelete).
    await waitFor(() => expect(view.editor.getState().graph!.nodes.map((n) => n.id)).toEqual(["b"]));
  });

  it("a hidden view ignores Backspace (React Flow listens on document)", async () => {
    const view = renderCanvas(false);
    await screen.findByText("Implement");
    fireEvent.keyDown(document.body, { key: "Backspace", code: "Backspace" });
    fireEvent.keyDown(document.body, { key: "Delete", code: "Delete" });
    await new Promise((r) => setTimeout(r, 50));
    expect(view.editor.getState().graph!.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(view.editor.getState().dirty).toBe(false);
  });
});
