import { beforeEach, describe, expect, it } from "vitest";
import { forkMergeGraph, nodeRunOf, runDetailOf } from "../test-fixtures";
import { handleServerMessage } from "./app-actions";
import { setRunStoreDeps, useRunStore } from "./run-store";
import { useUiStore } from "./ui-store";

describe("app actions: live updates", () => {
  const graph = forkMergeGraph();
  const running = nodeRunOf({ id: "nm", nodeId: "m", status: "running" });
  const paused = nodeRunOf({
    id: "nm",
    nodeId: "m",
    status: "waiting_input",
    ptyId: "shell-nm",
    waitingReason: { kind: "merge_conflict", message: "Conflicts in src/app.ts" },
  });

  beforeEach(async () => {
    setRunStoreDeps({ subscribe: () => undefined, unsubscribe: () => undefined, fetchRun: async () => runDetailOf(graph, []) });
    await useRunStore.getState().selectRun(null);
    useUiStore.getState().closeAllTerminals();
  });

  it("opens the merge shell in the drawer when the shown run's merge pauses on conflicts", () => {
    useRunStore.getState().showRun(runDetailOf(graph, [running]));
    handleServerMessage({ type: "node:update", nodeRun: paused });
    const ui = useUiStore.getState();
    expect(ui.terminalTabs).toEqual(["shell-nm"]);
    expect(ui.tabMeta["shell-nm"]).toEqual({ title: "Join (merge shell) · #ab12", nodeRunId: "nm" });
    expect(useRunStore.getState().currentByNode.m!.status).toBe("waiting_input");

    // Later updates of the same pause do not reopen a tab the user closed.
    useUiStore.getState().closeTerminal("shell-nm");
    handleServerMessage({ type: "node:update", nodeRun: { ...paused, updatedAt: 5 } });
    expect(useUiStore.getState().terminalTabs).toEqual([]);
  });

  it("does not open terminals for runs that are not shown", () => {
    useRunStore.getState().showRun(runDetailOf(graph, [running]));
    handleServerMessage({ type: "node:update", nodeRun: { ...paused, runId: "other" } });
    expect(useUiStore.getState().terminalTabs).toEqual([]);
  });
});
