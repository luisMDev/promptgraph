// @vitest-environment jsdom
import type { RunSummary } from "@promptgraph/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, nodeRunOf, runDetailOf } from "../../test-fixtures";
import { useAppStore } from "../../store/app-store";
import { useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { PendingApprovals, RunSelector, UndoRedoControls } from "./RunControls";

const graph = linearGraph();

function runSummary(id: string, shortId: string, status: RunSummary["status"]): RunSummary {
  const { graphSnapshot: _snapshot, ...run } = runDetailOf(graph, [], id).run;
  return { ...run, shortId, status };
}

const original = {
  selectRun: useRunStore.getState().selectRun,
  setLeftPanel: useUiStore.getState().setLeftPanel,
  openApproval: useUiStore.getState().openApproval,
};

afterEach(() => {
  cleanup();
  useRunStore.setState({ selectRun: original.selectRun, runs: [], selectedRunId: null });
  useUiStore.setState({ setLeftPanel: original.setLeftPanel, openApproval: original.openApproval });
  useAppStore.setState({ pending: [], pendingRuns: {} });
});

describe("RunSelector menu", () => {
  const selectRun = vi.fn(async () => {});
  const setLeftPanel = vi.fn();

  beforeEach(() => {
    selectRun.mockClear();
    setLeftPanel.mockClear();
    useEditorStore.setState({ graph });
    useRunStore.setState({ runs: [runSummary("r1", "ab12", "succeeded"), runSummary("r2", "cd34", "running")], selectedRunId: null, selectRun });
    useUiStore.setState({ setLeftPanel });
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
    expect(selectRun).not.toHaveBeenCalled();
  });

  it("selecting a run, the editor or the history entry calls the right action", async () => {
    const user = userEvent.setup();
    render(<RunSelector />);
    const trigger = screen.getByRole("button", { name: /Editor/ });

    await user.click(trigger);
    await user.click(screen.getByRole("menuitemradio", { name: /#cd34/ }));
    expect(selectRun).toHaveBeenLastCalledWith("r2");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitemradio", { name: /Editor/ }));
    expect(selectRun).toHaveBeenLastCalledWith(null);

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
    expect(selectRun).toHaveBeenCalledWith("r1");

    useRunStore.setState({ selectedRunId: "r1" });
    rerender(<RunSelector />);
    expect(screen.getByRole("button", { name: /Run #ab12/ })).toBeTruthy();
  });

  it("hides the history entry when there are no runs", async () => {
    const user = userEvent.setup();
    useRunStore.setState({ runs: [] });
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
    useUiStore.setState({ openApproval });
    useAppStore.setState({
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

  it("selecting an approval opens it and closes the menu", async () => {
    const user = userEvent.setup();
    render(<PendingApprovals />);
    await user.click(screen.getByRole("button", { name: "2 approvals pending" }));
    await user.click(screen.getByRole("menuitem", { name: /run r9/ }));
    expect(openApproval).toHaveBeenCalledWith("nr2");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("with nothing pending, shows a note that is not a selectable item", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ pending: [], pendingRuns: {} });
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

describe("UndoRedoControls", () => {
  beforeEach(() => {
    useEditorStore.setState({ graph, activeRunId: null, loadError: null, externalUndo: null, saving: false, past: [], future: [] });
    useRunStore.setState({ selectedRunId: null });
  });

  afterEach(() => {
    useEditorStore.setState({ past: [], future: [] });
  });

  it("is always shown, disabled while there is nothing to undo or redo", () => {
    render(<UndoRedoControls />);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Undo after an edit and Redo after an undo", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ past: [graph] });
    render(<UndoRedoControls />);
    const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    await user.click(undo);
    expect(useEditorStore.getState().past).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays disabled while a run is shown", () => {
    useEditorStore.setState({ past: [graph], future: [graph] });
    useRunStore.setState({ selectedRunId: "r1" });
    render(<UndoRedoControls />);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
