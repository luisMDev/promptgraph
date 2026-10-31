// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeRunOf, runDetailOf, testFixLoopGraph } from "../../test-fixtures";
import { setRunStoreDeps, useRunStore } from "../../store/run-store";
import { useEditorStore } from "../../store/editor-store";
import { useUiStore } from "../../store/ui-store";
import { Inspector } from "./Inspector";

describe("inspector (phase 2)", () => {
  beforeEach(async () => {
    setRunStoreDeps({ subscribe: vi.fn(), unsubscribe: vi.fn(), fetchRun: vi.fn() });
    await useRunStore.getState().selectRun(null);
  });
  afterEach(cleanup);

  it("browses previous loop iterations of a node; older ones are read-only", () => {
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

    fireEvent.click(screen.getByRole("tab", { name: /#1/ }));
    expect(useRunStore.getState().selectedIteration).toBe(0);
    expect(screen.getByText("Iteration 1 of 2")).toBeTruthy();
    expect(screen.getByText("1 failing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: /Terminal/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    expect(useRunStore.getState().selectedIteration).toBeNull();
    expect(screen.getByText("2 failing")).toBeTruthy();
  });

  it("the terminal drawer follows the selected iteration when it shows this node", () => {
    const detail = runDetailOf(testFixLoopGraph(), [
      nodeRunOf({ id: "t0", nodeId: "test", status: "failed", ptyId: "t0", output: { exitCode: 1 } }),
      nodeRunOf({ id: "t1", nodeId: "test", iteration: 1, status: "failed", ptyId: "t1", output: { exitCode: 2 } }),
    ]);
    useUiStore.getState().closeAllTerminals();
    useRunStore.getState().showRun(detail);
    useRunStore.getState().selectNode("test");
    render(<Inspector />);
    // Closed drawer: selecting an iteration opens nothing.
    fireEvent.click(screen.getByRole("tab", { name: /#1/ }));
    expect(useUiStore.getState().drawerOpen).toBe(false);

    useUiStore.getState().openTerminal("t1", { title: "Run tests", nodeRunId: "t1" });
    fireEvent.click(screen.getByRole("tab", { name: /#1/ }));
    expect(useUiStore.getState().activeTerminal).toBe("t0");
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
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

  it("edits an edge's condition and loop settings", () => {
    const graph = testFixLoopGraph();
    useEditorStore.setState({ graph, phase: 2, validation: { errors: [], warnings: [] }, selectedNodeIds: [], selectedEdgeIds: ["e1"], selectedNodeId: null, selectedEdgeId: "e1", activeRunId: null });
    render(<Inspector />);
    fireEvent.change(screen.getByLabelText(/Follow when/), { target: { value: "always" } });
    expect(useEditorStore.getState().graph!.edges.find((e) => e.id === "e1")!.when).toBe("always");
    fireEvent.click(screen.getByLabelText("Loop back-edge"));
    expect(useEditorStore.getState().graph!.edges.find((e) => e.id === "e1")!.loop).toEqual({ maxIterations: 3, onExhausted: "fail" });
  });
});
