// @vitest-environment jsdom
import { LAYOUT_DY, type RunSummary } from "@promptgraph/shared";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, nodeRunOf, runDetailOf } from "../../test-fixtures";
import { createTestView, type TestView } from "../../store/view/test-view";
import { PendingApprovals, RunControls, RunSelector } from "./RunControls";

const graph = linearGraph();

function runSummary(id: string, shortId: string, status: RunSummary["status"]): RunSummary {
  const { graphSnapshot: _snapshot, ...run } = runDetailOf(graph, [], id).run;
  return { ...run, shortId, status };
}

let view: TestView;
const render = (ui: Parameters<TestView["render"]>[0]) => view.render(ui);
const R = "/r/repo-0123abcd";

afterEach(cleanup);

describe("RunSelector (§13.2)", () => {
  const deleteRun = vi.fn(async (_id: string) => undefined);

  beforeEach(() => {
    deleteRun.mockClear();
    view = createTestView({ graphId: "g1", path: `${R}/graphs/g1`, api: { deleteRun } });
    view.editor.setState({ graph, loading: false });
    view.run.setState({ runs: [runSummary("r1", "ab12", "succeeded"), runSummary("r2", "cd34", "running")], selectedRunId: null });
  });

  const rows = () => screen.getAllByRole("link", { name: /^(Editor|Run #)/ });

  it("opens from the keyboard on the shown entry, ↑/↓ move between the rows, Escape returns to the trigger", async () => {
    const user = userEvent.setup();
    render(<RunSelector />);
    const trigger = screen.getByRole("button", { name: /Editor/ });
    trigger.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Editor and runs" });
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("Editor"), expect.stringContaining("#ab12"), expect.stringContaining("#cd34")]);
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0]!.getAttribute("aria-current")).toBe("page");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(rows()[2]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[1]);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(view.location.navigations).toEqual([]);
  });

  it("rows link to the run, its report and the editor, and close the popover", async () => {
    const user = userEvent.setup();
    render(<RunSelector />);
    const trigger = screen.getByRole("button", { name: /Editor/ });

    await user.click(trigger);
    expect(screen.getByRole("link", { name: /Run #cd34/ }).getAttribute("href")).toBe(`${R}/runs/r2`);
    await user.click(screen.getByRole("link", { name: /Run #cd34/ }));
    expect(view.location.navigations.at(-1)).toEqual({ path: `${R}/runs/r2`, replace: false });
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole("link", { name: "Report of run #ab12" }));
    expect(view.location.navigations.at(-1)?.path).toBe(`${R}/runs/r1/report`);

    await user.click(trigger);
    await user.click(screen.getByRole("link", { name: /^Editor/ }));
    expect(view.location.navigations.at(-1)?.path).toBe(`${R}/graphs/g1`);
  });

  it("deletes a finished run after a confirmation; an active run cannot be deleted", async () => {
    const user = userEvent.setup();
    render(<RunSelector />);
    await user.click(screen.getByRole("button", { name: /Editor/ }));
    expect((screen.getByRole("button", { name: "Delete run #cd34" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Delete run #ab12" }));

    const confirm = await screen.findByRole("dialog", { name: "Delete run #ab12" });
    expect(confirm.textContent).toMatch(/pushed or have commits are kept/);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(view.run.getState().runs.map((r) => r.id)).toEqual(["r2"]));
  });

  it("shows the selected run on the trigger, and an empty history", async () => {
    view.run.setState({ selectedRunId: "r1" });
    const { rerender } = render(<RunSelector />);
    expect(screen.getByRole("button", { name: /Run #ab12/ })).toBeTruthy();

    act(() => view.run.setState({ runs: [], selectedRunId: null }));
    rerender(<RunSelector />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Editor/ }));
    expect(screen.getByText("No runs yet.")).toBeTruthy();
  });
});

describe("PendingApprovals menu", () => {
  const openApproval = vi.fn();

  beforeEach(() => {
    openApproval.mockClear();
    view = createTestView({ path: `${R}/graphs/g1` });
    view.ui.setState({ openApproval });
    view.cache.setState({
      pending: [
        nodeRunOf({ id: "nr1", nodeId: "a", status: "waiting_approval" }),
        nodeRunOf({ id: "nr2", nodeId: "b", runId: "r9", status: "waiting_approval" }),
      ],
      pendingRuns: { r1: { graphName: "Graph 1", shortId: "ab12", nodeLabels: { a: "Implement" } } as never },
    });
  });

  it("names the icon-only trigger, opens from the keyboard, navigates and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<PendingApprovals />);
    const trigger = screen.getByRole("button", { name: "2 approvals pending" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");

    const menu = await screen.findByRole("menu");
    expect(menu.contains(document.activeElement)).toBe(true);
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Implement");
    expect(items[0]?.textContent).toContain("Graph 1 · run #ab12");
    expect(items[1]?.textContent).toContain("run r9");

    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(openApproval).not.toHaveBeenCalled();
  });

  it("selecting an approval goes to its node run, opens the dialog and closes the menu", async () => {
    const user = userEvent.setup();
    render(<PendingApprovals />);
    await user.click(screen.getByRole("button", { name: "2 approvals pending" }));
    await user.click(screen.getByRole("menuitem", { name: /run r9/ }));
    expect(view.location.navigations.at(-1)?.path).toBe(`${R}/runs/r9/nodes/nr2`);
    expect(openApproval).toHaveBeenCalledWith("nr2");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Ctrl-click on an approval opens its node run in a background tab, without the dialog here", async () => {
    const user = userEvent.setup();
    render(<PendingApprovals />);
    await user.click(screen.getByRole("button", { name: "2 approvals pending" }));
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("menuitem", { name: /run r9/ }));
    await user.keyboard("{/Control}");
    expect(view.location.newTabs).toEqual([{ path: `${R}/runs/r9/nodes/nr2`, activate: false }]);
    expect(openApproval).not.toHaveBeenCalled();
  });

  it("with nothing pending, shows a note that is not a selectable item", async () => {
    const user = userEvent.setup();
    view.cache.setState({ pending: [], pendingRuns: {} });
    render(<PendingApprovals />);
    const trigger = screen.getByRole("button", { name: "No pending approvals" });
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(screen.getByText("No approvals pending.")).toBeTruthy();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);

    await user.click(screen.getByText("No approvals pending."));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(openApproval).not.toHaveBeenCalled();
    expect(menu.isConnected).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Arrange button (§19.3)", () => {
  beforeEach(() => {
    view = createTestView({ graphId: "g1", path: `${R}/graphs/g1` });
    // Positions the automatic layout would not choose.
    view.editor.setState({ graph: { ...graph, nodes: graph.nodes.map((n, i) => ({ ...n, position: { x: i * 37, y: 500 - i * 11 } })) }, loading: false });
  });

  const arrange = () => screen.getByRole("button", { name: /Arrange/ }) as HTMLButtonElement;

  it("lays the nodes out, as one undoable edit, asks the canvas to fit, then is disabled until something moves", async () => {
    const user = userEvent.setup();
    render(<RunControls />);
    expect(arrange().disabled).toBe(false);
    await user.click(arrange());
    const nodes = view.editor.getState().graph!.nodes;
    expect(new Set(nodes.map((n) => n.position.x)).size).toBe(1);
    expect(nodes.map((n) => n.position.y)).toEqual(nodes.map((_, i) => i * LAYOUT_DY));
    expect(view.editor.getState().dirty).toBe(true);
    expect(view.ui.getState().fitRequest).toBe(1);
    expect(arrange().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(view.editor.getState().graph!.nodes[0]!.position).toEqual({ x: 0, y: 500 });
    expect(arrange().disabled).toBe(false);
  });

  it("is disabled while a run is shown", () => {
    view.run.setState({ selectedRunId: "r1" });
    render(<RunControls />);
    expect(arrange().disabled).toBe(true);
  });
});

describe("Undo / Redo controls", () => {
  beforeEach(() => {
    view = createTestView({ graphId: "g1", path: `${R}/graphs/g1` });
    view.editor.setState({ graph, loading: false });
  });

  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("are always shown next to Run, disabled while there is nothing to undo or redo", () => {
    render(<RunControls />);
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
    // Left of Run, in the same row.
    const history = screen.getByRole("group", { name: "History" });
    const run = screen.getByRole("button", { name: /Run/ });
    expect(history.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("enable Undo after an edit and Redo after an undo", async () => {
    const user = userEvent.setup();
    render(<RunControls />);
    act(() => view.editor.getState().rename("Renamed"));
    expect(button("Undo").disabled).toBe(false);
    await user.click(button("Undo"));
    expect(view.editor.getState().graph?.name).toBe(graph.name);
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(false);
  });

  it("stay shown but disabled while a run is shown or active", () => {
    view.editor.setState({ past: [graph], future: [graph] });
    view.run.setState({ selectedRunId: "r1" });
    render(<RunControls />);
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
    act(() => {
      view.run.setState({ selectedRunId: null });
      view.editor.setState({ activeRunId: "r1" });
    });
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
  });
});
