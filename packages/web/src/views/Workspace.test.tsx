// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linearGraph } from "../test-fixtures";
import { createTestView, TEST_REPO_ID, type TestView } from "../store/view/test-view";
import { SIDEBAR_WIDTH } from "../store/view/ui-store";
import { Workspace } from "./Workspace";

const graph = linearGraph();
let view: TestView;

function renderWorkspace() {
  return view.render(<Workspace route={{ kind: "graph", repoId: TEST_REPO_ID, graphId: "g1" }} />);
}

beforeEach(() => {
  localStorage.clear();
  view = createTestView({ graphId: "g1", graphs: [{ id: "g1", name: "Graph 1", loadError: null, updatedAt: 1, hash: "h0" }] });
  view.editor.setState({ graph, graphHash: "h0", loading: false });
});
afterEach(cleanup);

describe("workspace layout", () => {
  it("switches the left panel from the header's Nodes / Runs switch and collapses it from inside the sidebar", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace();
    await screen.findByText("Implement");

    const header = container.querySelector("header")!;
    const runsItem = screen.getByRole("radio", { name: /^Runs/ });
    expect(header.contains(runsItem)).toBe(true);
    expect(screen.getByRole("radio", { name: "Nodes" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("region", { name: "Nodes" }).textContent).toContain("Prompt");
    await user.click(runsItem);
    expect(runsItem.getAttribute("aria-checked")).toBe("true");
    expect(view.ui.getState().leftPanel).toBe("history");
    expect(screen.getByRole("region", { name: "Runs" }).textContent).toContain("No runs yet.");

    const sidebar = container.querySelector('[data-slot="sidebar"]');
    const panel = container.querySelector('[data-slot="sidebar-container"]');
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.contains(collapse)).toBe(true);
    expect(panel?.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();

    await user.click(collapse);
    expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
    // Collapsed off-canvas: out of the Tab order and the accessibility tree; the canvas offers the expand button.
    expect(panel?.hasAttribute("inert")).toBe(true);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    await user.click(expand);
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();

    // Asking for a panel (e.g. "Open run history…" in the run menu) re-expands a collapsed sidebar.
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
    act(() => view.ui.getState().setLeftPanel("history"));
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    expect(panel?.hasAttribute("inert")).toBe(false);

    // So does clicking the switch, also on the panel already shown.
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    await user.click(screen.getByRole("radio", { name: /^Runs/ }));
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
  });

  it("collapses the inspector from its edge rail and brings it back from the canvas", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace();
    await screen.findByText("Implement");

    const inspector = container.querySelector('[data-slot="sidebar"][data-side="right"]');
    expect(inspector?.getAttribute("data-state")).toBe("expanded");
    expect(screen.queryByRole("button", { name: "Expand inspector" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Collapse or resize inspector" }));
    expect(inspector?.getAttribute("data-state")).toBe("collapsed");
    // The left sidebar is independent of the inspector.
    expect(container.querySelector('[data-slot="sidebar"][data-side="left"]')?.getAttribute("data-state")).toBe("expanded");

    await user.click(screen.getByRole("button", { name: "Expand inspector" }));
    expect(inspector?.getAttribute("data-state")).toBe("expanded");
  });

  it("resizes a sidebar by dragging its rail without collapsing it", async () => {
    const { container } = renderWorkspace();
    await screen.findByText("Implement");

    const rail = screen.getByRole("button", { name: "Collapse or resize sidebar" });
    const panel = rail.closest<HTMLElement>('[data-slot="sidebar-container"]')!;
    panel.getBoundingClientRect = () => ({ width: SIDEBAR_WIDTH.default }) as DOMRect;
    // jsdom has no pointer capture.
    rail.setPointerCapture = () => {};
    rail.hasPointerCapture = () => false;

    fireEvent.pointerDown(rail, { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(rail, { clientX: 300, pointerId: 1 });
    expect(document.documentElement.hasAttribute("data-sidebar-resizing")).toBe(true);
    fireEvent.pointerMove(rail, { clientX: 2000, pointerId: 1 });
    fireEvent.pointerUp(rail, { clientX: 2000, pointerId: 1 });
    fireEvent.click(rail);

    expect(view.ui.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max);
    // Widths are global preferences: a new view starts with the stored width.
    expect(localStorage.getItem("promptgraph.sidebarWidth")).toBe(String(SIDEBAR_WIDTH.max));
    expect(createTestView().ui.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max);
    expect(document.documentElement.hasAttribute("data-sidebar-resizing")).toBe(false);
    // The click that ends a drag does not toggle the sidebar.
    expect(container.querySelector('[data-slot="sidebar"][data-side="left"]')?.getAttribute("data-state")).toBe("expanded");
  });

  it("leaving run mode with the Nodes switch navigates back to the graph", async () => {
    const user = userEvent.setup();
    view.run.setState({ selectedRunId: "r1" });
    renderWorkspace();
    expect(screen.getByRole("radio", { name: /^Runs/ }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "Nodes" }));
    expect(view.location.navigations.at(-1)?.path).toBe(`/r/${TEST_REPO_ID}/graphs/g1`);
  });
});
