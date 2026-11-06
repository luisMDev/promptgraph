import type { RepoInfoResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoApi } from "../api/rest";
import { forkMergeGraph, nodeRunOf, runDetailOf } from "../test-fixtures";
import { createDispatcher, type Dispatcher } from "./dispatcher";
import { clearRepoCaches, createRepoCache, setRepoCache } from "./repo-cache";
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

describe("dispatcher: reconnect", () => {
  afterEach(() => clearRepoCaches());

  it("loads again a repository cache whose first load failed while the daemon was down", async () => {
    const info = vi.fn<() => Promise<RepoInfoResponse>>().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    info.mockResolvedValue({ id: REPO, path: "/r", name: "r", currentBranch: "main", branches: ["main"] });
    const api = { info, listGraphs: async () => ({ graphs: [] }), pending: async () => ({ nodeRuns: [] }) } as unknown as RepoApi;
    const cache = createRepoCache(REPO, api);
    setRepoCache(REPO, cache);
    await cache.getState().load();
    expect(cache.getState().infoError).not.toBeNull();

    const d = createDispatcher();
    d.handle({ type: "hello", version: "0" });
    d.handle({ type: "hello", version: "0" });
    await vi.waitFor(() => expect(cache.getState().info?.name).toBe("r"));
    expect(cache.getState().infoError).toBeNull();
  });
});
