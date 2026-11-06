// @vitest-environment jsdom
import type { RunSummary } from "@promptgraph/shared";
import { act, cleanup, screen } from "@testing-library/react";
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

describe("RunSelector menu", () => {
  const setLeftPanel = vi.fn();

  beforeEach(() => {
    setLeftPanel.mockClear();
    view = createTestView({ graphId: "g1", path: `${R}/graphs/g1` });
    view.editor.setState({ graph, loading: false });
    view.run.setState({ runs: [runSummary("r1", "ab12", "succeeded"), runSummary("r2", "cd34", "running")], selectedRunId: null });
    view.ui.setState({ setLeftPanel });
  });

  it("opens from the keyboard, moves focus between items and closes on Escape back to the trigger", async () => {
    const user = userEvent.setup();
    render(<RunSelector />);
    const trigger = screen.getByRole("button", { name: /Editor/ });
    trigger.focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu");
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Editor"), expect.stringContaining("#ab12"), expect.stringContaining("#cd34")]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[2]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(view.location.navigations).toEqual([]);
  });

  it("runs and the editor are links; the history entry opens the panel", async () => {
    const user = userEvent.setup();
    render(<RunSelector />);
    const trigger = screen.getByRole("button", { name: /Editor/ });

    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: /#cd34/ }).getAttribute("href")).toBe(`${R}/runs/r2`);
    await user.click(screen.getByRole("menuitemradio", { name: /#cd34/ }));
    expect(view.location.navigations.at(-1)).toEqual({ path: `${R}/runs/r2`, replace: false });
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitemradio", { name: /Editor/ }));
    expect(view.location.navigations.at(-1)?.path).toBe(`${R}/graphs/g1`);

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Open run history…" }));
    expect(setLeftPanel).toHaveBeenCalledWith("history");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("selects with the keyboard and shows the selected run on the trigger", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RunSelector />);
    screen.getByRole("button", { name: /Editor/ }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(view.location.navigations.at(-1)?.path).toBe(`${R}/runs/r1`);

    view.run.setState({ selectedRunId: "r1" });
    rerender(<RunSelector />);
    expect(screen.getByRole("button", { name: /Run #ab12/ })).toBeTruthy();
  });

  it("hides the history entry when there are no runs", async () => {
    const user = userEvent.setup();
    view.run.setState({ runs: [] });
    render(<RunSelector />);
    await user.click(screen.getByRole("button", { name: /Editor/ }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "Open run history…" })).toBeNull();
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
