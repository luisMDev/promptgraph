import { beforeEach, describe, expect, it } from "vitest";
import { forkMergeGraph, nodeRunOf, runDetailOf } from "../test-fixtures";
import { createDispatcher, type Dispatcher } from "./dispatcher";
import { createRunStore, type RunStoreApi } from "./view/run-store";
import { createViewUiStore, type ViewUiStoreApi } from "./view/ui-store";

const REPO = "repo-0123abcd";

describe("dispatcher: live updates", () => {
  const graph = forkMergeGraph();
  const running = nodeRunOf({ id: "nm", nodeId: "m", status: "running" });
  const paused = nodeRunOf({
    id: "nm",
    nodeId: "m",
    status: "waiting_input",
    ptyId: "shell-nm",
    waitingReason: { kind: "merge_conflict", message: "Conflicts in src/app.ts" },
  });
  let d: Dispatcher;
  let run: RunStoreApi;
  let ui: ViewUiStoreApi;

  beforeEach(() => {
    d = createDispatcher();
    run = createRunStore(REPO, { subscribe: () => () => undefined, fetchRun: async () => runDetailOf(graph, []), listRuns: async () => [] });
    ui = createViewUiStore();
    d.registerView({ repoId: REPO, run, ui });
  });

  it("opens the merge shell in the drawer when the shown run's merge pauses on conflicts", () => {
    run.getState().showRun(runDetailOf(graph, [running]));
    d.handle({ type: "node:update", nodeRun: paused });
    expect(ui.getState().terminalTabs).toEqual(["shell-nm"]);
    expect(ui.getState().tabMeta["shell-nm"]).toEqual({ title: "Join (merge shell) · #ab12", nodeRunId: "nm" });
    expect(run.getState().currentByNode.m!.status).toBe("waiting_input");

    // Later updates of the same pause do not reopen a tab the user closed.
    ui.getState().closeTerminal("shell-nm");
    d.handle({ type: "node:update", nodeRun: { ...paused, updatedAt: 5 } });
    expect(ui.getState().terminalTabs).toEqual([]);
  });

  it("does not open terminals for runs that are not shown", () => {
    run.getState().showRun(runDetailOf(graph, [running]));
    d.handle({ type: "node:update", nodeRun: { ...paused, runId: "other" } });
    expect(ui.getState().terminalTabs).toEqual([]);
  });

  it("routes run updates only to views of their repository", () => {
    const other = createRunStore("other-00000001", { subscribe: () => () => undefined, fetchRun: async () => runDetailOf(graph, []), listRuns: async () => [] });
    d.registerView({ repoId: "other-00000001", run: other, ui: createViewUiStore() });
    run.setState({ graphId: graph.id });
    other.setState({ graphId: graph.id });
    const { graphSnapshot: _g, ...summary } = runDetailOf(graph, []).run;
    d.handle({ type: "run:update", repoId: REPO, run: summary });
    expect(run.getState().runs.map((r) => r.id)).toEqual(["r1"]);
    expect(other.getState().runs).toEqual([]);
  });

  it("stops routing to a view once it unregisters", () => {
    const unregister = d.registerView({ repoId: REPO, run: createRunStore(REPO), ui: createViewUiStore() });
    unregister();
    run.getState().showRun(runDetailOf(graph, [running]));
    d.handle({ type: "node:update", nodeRun: paused });
    expect(ui.getState().terminalTabs).toEqual(["shell-nm"]);
  });
});
