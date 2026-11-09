// @vitest-environment jsdom
import type { RunBriefEntry, RunDetail } from "@promptgraph/shared";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, runDetailOf } from "../../test-fixtures";
import { createTestView, type TestView } from "../../store/view/test-view";
import { RunSummary } from "./RunReport";

function entryOf(patch: Partial<RunBriefEntry> & Pick<RunBriefEntry, "id">): RunBriefEntry {
  return {
    runId: "r1",
    kind: "run",
    nodeRunId: null,
    nodeId: null,
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

function detailOf(opts: { enabled?: boolean; status?: RunDetail["run"]["status"]; brief?: RunBriefEntry[] }): RunDetail {
  const graph = linearGraph();
  const detail = runDetailOf({ ...graph, settings: { ...graph.settings, brief: { enabled: opts.enabled ?? true } } }, []);
  return { ...detail, run: { ...detail.run, status: opts.status ?? "succeeded" }, brief: opts.brief ?? [] };
}

describe("run report: Run summary (§13.1)", () => {
  let view: TestView;
  beforeEach(() => {
    view = createTestView({ runDeps: { subscribe: vi.fn(() => () => undefined), fetchRun: vi.fn() } });
  });
  afterEach(cleanup);

  it("shows the run's closing brief entry, the latest one, with its sections", () => {
    const summary = "### How it went\n- All steps passed.\n\n### Decisions\n- The check took the **true** branch.";
    view.run.getState().showRun(
      detailOf({
        brief: [
          entryOf({ id: 1, kind: "node", nodeId: "a", nodeRunId: "nr-a", title: "Step done" }),
          entryOf({ id: 2, title: "Old summary", summary: "- stale" }),
          entryOf({ id: 3, title: "Shipped the parser", summary }),
        ],
      }),
    );
    view.render(<RunSummary runId="r1" />);
    expect(screen.getByText("Run summary")).toBeTruthy();
    expect(screen.getByText("Shipped the parser")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Decisions" })).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.queryByText("Old summary")).toBeNull();
    expect(screen.queryByText("Step done")).toBeNull();
  });

  it("says when it is being written, failed, comes at the end of the run, or needs the run brief", () => {
    view.run.getState().showRun(detailOf({ brief: [entryOf({ id: 1, status: "pending" })] }));
    const { unmount } = view.render(<RunSummary runId="r1" />);
    expect(screen.getByText("Summarising the run…")).toBeTruthy();
    unmount();

    view.run.getState().showRun(detailOf({ brief: [entryOf({ id: 1, status: "failed", error: "timed out" })] }));
    const failed = view.render(<RunSummary runId="r1" />);
    expect(screen.getByText("No summary: timed out")).toBeTruthy();
    failed.unmount();

    view.run.getState().showRun(detailOf({ status: "running" }));
    const running = view.render(<RunSummary runId="r1" />);
    expect(screen.getByText("The summary is written when the run ends.")).toBeTruthy();
    running.unmount();

    view.run.getState().showRun(detailOf({ enabled: false }));
    const off = view.render(<RunSummary runId="r1" />);
    expect(screen.getByText(/to get a summary of each run/)).toBeTruthy();
    off.unmount();

    // A finished run without any summarised step has no summary section.
    view.run.getState().showRun(detailOf({}));
    view.render(<RunSummary runId="r1" />);
    expect(screen.queryByText("Run summary")).toBeNull();
  });
});
