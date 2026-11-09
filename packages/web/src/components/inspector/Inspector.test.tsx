// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf, nodeRunOf, runDetailOf, testFixLoopGraph } from "../../test-fixtures";
import { createTestView, type TestView } from "../../store/view/test-view";
import { Inspector } from "./Inspector";

describe("inspector (phase 2)", () => {
  let view: TestView;
  let useRunStore: TestView["run"];
  let useEditorStore: TestView["editor"];
  let useUiStore: TestView["ui"];
  const render = (ui: Parameters<TestView["render"]>[0]) => view.render(ui);

  beforeEach(() => {
    view = createTestView({ runDeps: { subscribe: vi.fn(() => () => undefined), fetchRun: vi.fn() } });
    ({ run: useRunStore, editor: useEditorStore, ui: useUiStore } = view);
  });
  afterEach(cleanup);

  it("browses previous loop iterations of a node; older ones are read-only", async () => {
    const user = userEvent.setup();
    const detail = runDetailOf(testFixLoopGraph(), [
      nodeRunOf({ id: "t0", nodeId: "test", status: "failed", ptyId: "t0", output: { exitCode: 1, stdoutTail: "1 failing" }, startedAt: 1, finishedAt: 2 }),
      nodeRunOf({ id: "t1", nodeId: "test", iteration: 1, status: "failed", ptyId: "t1", output: { exitCode: 2, stdoutTail: "2 failing" } }),
    ]);
    useRunStore.getState().showRun(detail);
    useRunStore.getState().selectNode("test");
    render(<Inspector />);

    expect(screen.getByText("Iteration 2 of 2")).toBeTruthy();
    expect(screen.getByText("2 failing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /#1/ }));
    expect(useRunStore.getState().selectedIteration).toBe(0);
    expect(screen.getByText("Iteration 1 of 2")).toBeTruthy();
    expect(screen.getByText("1 failing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: /Terminal/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Latest" }));
    expect(useRunStore.getState().selectedIteration).toBeNull();
    expect(screen.getByText("2 failing")).toBeTruthy();
  });

  it("the terminal drawer follows the selected iteration when it shows this node", async () => {
    const user = userEvent.setup();
    const detail = runDetailOf(testFixLoopGraph(), [
      nodeRunOf({ id: "t0", nodeId: "test", status: "failed", ptyId: "t0", output: { exitCode: 1 } }),
      nodeRunOf({ id: "t1", nodeId: "test", iteration: 1, status: "failed", ptyId: "t1", output: { exitCode: 2 } }),
    ]);
    useUiStore.getState().closeAllTerminals();
    useRunStore.getState().showRun(detail);
    useRunStore.getState().selectNode("test");
    render(<Inspector />);
    // Closed drawer: selecting an iteration opens nothing.
    await user.click(screen.getByRole("tab", { name: /#1/ }));
    expect(useUiStore.getState().drawerOpen).toBe(false);

    useUiStore.getState().openTerminal("t1", { title: "Run tests", nodeRunId: "t1" });
    await user.click(screen.getByRole("tab", { name: /#1/ }));
    expect(useUiStore.getState().activeTerminal).toBe("t0");
    await user.click(screen.getByRole("button", { name: "Latest" }));
    expect(useUiStore.getState().activeTerminal).toBe("t1");
    useUiStore.getState().closeAllTerminals();
  });

  it("shows a condition's evaluator, result and reason in run mode", () => {
    const detail = runDetailOf(testFixLoopGraph(), [
      nodeRunOf({ id: "c0", nodeId: "cond", status: "succeeded", output: { port: "false", result: false, text: "Exit code 1, expected 0" } }),
    ]);
    useRunStore.getState().showRun(detail);
    useRunStore.getState().selectNode("cond");
    render(<Inspector />);
    expect(screen.getByText("exit code = 0")).toBeTruthy();
    expect(screen.getByText("false")).toBeTruthy();
    expect(screen.getByText("Exit code 1, expected 0")).toBeTruthy();
  });

  it("opens a node's own diff (§9.7) when it has a snapshot", () => {
    const detail = runDetailOf(testFixLoopGraph(), [
      nodeRunOf({ id: "t0", nodeId: "test", status: "succeeded", snapshotStart: "s1", snapshotEnd: "s2" }),
      nodeRunOf({ id: "c0", nodeId: "cond", status: "succeeded", output: { port: "true", result: true } }),
    ]);
    useUiStore.getState().openDiff(null);
    useRunStore.getState().showRun(detail);
    useRunStore.getState().selectNode("cond");
    render(<Inspector />);
    expect(screen.queryByRole("button", { name: "View diff" })).toBeNull();
    cleanup();

    useRunStore.getState().selectNode("test");
    render(<Inspector />);
    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    expect(useUiStore.getState().diffTarget).toMatchObject({ kind: "node", nodeRunId: "t0" });
    useUiStore.getState().openDiff(null);
  });

  it("edits an edge's condition and loop settings", () => {
    const graph = testFixLoopGraph();
    useEditorStore.setState({ graph, phase: 2, validation: { errors: [], warnings: [] }, selectedNodeIds: [], selectedEdgeIds: ["e1"], selectedNodeId: null, selectedEdgeId: "e1", activeRunId: null });
    render(<Inspector />);
    fireEvent.change(screen.getByLabelText(/Follow when/), { target: { value: "always" } });
    expect(useEditorStore.getState().graph!.edges.find((e) => e.id === "e1")!.when).toBe("always");
    fireEvent.click(screen.getByLabelText("Loop back-edge"));
    expect(useEditorStore.getState().graph!.edges.find((e) => e.id === "e1")!.loop).toEqual({ maxIterations: 3, onExhausted: "fail" });
  });

  it("renames the graph from the graph settings on Enter; Escape and an empty name restore it", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ graph: graphOf({ id: "g1", name: "Original" }), graphId: "g1", loading: false, loadError: null, activeRunId: null });
    render(<Inspector />);
    const name = "Original";
    const field = screen.getByRole("textbox", { name: /^Name/ });
    expect((field as HTMLInputElement).value).toBe(name);

    await user.clear(field);
    await user.type(field, "Draft{Escape}");
    expect(useEditorStore.getState().graph!.name).toBe(name);
    expect((screen.getByRole("textbox", { name: /^Name/ }) as HTMLInputElement).value).toBe(name);

    await user.clear(screen.getByRole("textbox", { name: /^Name/ }));
    await user.tab();
    expect(useEditorStore.getState().graph!.name).toBe(name);

    await user.clear(screen.getByRole("textbox", { name: /^Name/ }));
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Renamed graph{Enter}");
    expect(useEditorStore.getState().graph!.name).toBe("Renamed graph");
  });
});
