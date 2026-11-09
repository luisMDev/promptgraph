// @vitest-environment jsdom
import type { RunBriefEntry } from "@promptgraph/shared";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, runDetailOf } from "../../test-fixtures";
import { createTestView, type TestView } from "../../store/view/test-view";
import { Inspector } from "./Inspector";

function entryOf(patch: Partial<RunBriefEntry> & Pick<RunBriefEntry, "id">): RunBriefEntry {
  return {
    runId: "r1",
    kind: "node",
    nodeRunId: `nr-${patch.id}`,
    nodeId: "a",
    outcome: "succeeded",
    status: "ready",
    title: null,
    summary: null,
    error: null,
    usage: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  };
}

function briefGraph(enabled: boolean) {
  const graph = linearGraph();
  return { ...graph, settings: { ...graph.settings, brief: { enabled } } };
}

describe("run brief in the inspector (§13.6)", () => {
  let view: TestView;
  beforeEach(() => {
    view = createTestView({ runDeps: { subscribe: vi.fn(() => () => undefined), fetchRun: vi.fn() } });
  });
  afterEach(cleanup);

  it("shows the timeline live and selects a step's node from its name", async () => {
    const user = userEvent.setup();
    view.run.getState().showRun({ ...runDetailOf(briefGraph(true), []), brief: [entryOf({ id: 1, title: "Implemented the parser", summary: "Added **parse()**." })] });
    view.render(<Inspector />);

    expect(screen.getByText("Implemented the parser")).toBeTruthy();
    expect(screen.getByText("parse()")).toBeTruthy();

    // brief:update: a new pending entry, then the same entry failed; stale updates are ignored.
    view.run.getState().applyBriefUpdate(entryOf({ id: 2, nodeId: "b", status: "pending", updatedAt: 2000 }));
    expect(await screen.findByText("Summarising…")).toBeTruthy();
    view.run.getState().applyBriefUpdate(entryOf({ id: 2, nodeId: "b", status: "failed", error: "timed out", updatedAt: 3000 }));
    view.run.getState().applyBriefUpdate(entryOf({ id: 2, nodeId: "b", status: "pending", updatedAt: 2500 }));
    expect(await screen.findByText("No summary: timed out")).toBeTruthy();
    expect(screen.queryByText("Summarising…")).toBeNull();
    // Another run's entry is not shown.
    view.run.getState().applyBriefUpdate(entryOf({ id: 3, runId: "other", title: "Elsewhere" }));
    expect(screen.queryByText("Elsewhere")).toBeNull();
    expect(screen.getAllByTestId("brief-entry")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(view.run.getState().selectedNodeId).toBe("b");
  });

  it("labels the closing entry with the run's result", () => {
    view.run.getState().showRun({
      ...runDetailOf(briefGraph(true), []),
      brief: [entryOf({ id: 1, kind: "run", nodeRunId: null, nodeId: null, outcome: "succeeded", title: "All done" })],
    });
    view.render(<Inspector />);
    expect(screen.getByText("Run succeeded")).toBeTruthy();
    expect(screen.getByText("All done")).toBeTruthy();
  });

  it("tells how to turn it on when the graph has it off", () => {
    view.run.getState().showRun(runDetailOf(briefGraph(false), []));
    view.render(<Inspector />);
    expect(screen.getByText(/in the graph settings to get a short summary/)).toBeTruthy();
  });
});
