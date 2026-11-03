import { webRoutes } from "@promptgraph/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { repoApi } from "../api/rest";
import { wsClient } from "../api/ws";
import { useLocation } from "../lib/router/location";
import { routeRunId, type RepoRoute } from "../lib/router/routes";
import { useDaemonStore } from "../store/daemon-store";
import { dispatcher } from "../store/live";
import { getRepoCache, useRepoCache } from "../store/repo-cache";
import { closeAllTerminals, lastGraphId, rememberGraph, showNodeRun } from "../store/view/actions";
import { ViewProvider, type View, type ViewStores } from "../store/view/context";
import { acquireEditorStore, createEditorStore, type EditorStoreApi } from "../store/view/editor-store";
import { createRunStore, type RunStoreApi } from "../store/view/run-store";
import { createViewUiStore } from "../store/view/ui-store";
import { FullScreenMessage, NotFound } from "./NotFound";
import { Workspace } from "./Workspace";

/**
 * One view of a repository (DESIGN §13.2): its run and UI stores, the shared editor store of the graph it
 * shows, its repository subscription, and the route applied to those stores (graph opened, run selected and
 * subscribed, node run shown). Mounted per repository; the route inside it changes freely.
 */
export function RepoView({ route, active = true }: { route: RepoRoute; active?: boolean }) {
  const { repoId } = route;
  const [own] = useState(() => ({ api: repoApi(repoId), run: createRunStore(repoId), ui: createViewUiStore() }));
  const cache = getRepoCache(repoId);
  const info = useRepoCache(repoId, (s) => s.info);
  const infoError = useRepoCache(repoId, (s) => s.infoError);
  const graphs = useRepoCache(repoId, (s) => s.graphs);

  useEffect(() => {
    void cache.getState().load();
  }, [cache]);

  useEffect(() => {
    own.run.getState().resume();
    const unregister = dispatcher.registerView({ repoId, run: own.run, ui: own.ui });
    // run:update and graphs:changed only reach subscribers of the repository (DESIGN §12.2).
    const unsubscribe = wsClient.subscribeRepo(repoId);
    return () => {
      unsubscribe();
      unregister();
      own.run.getState().dispose();
    };
  }, [own, repoId]);

  if (infoError?.status === 404) return <NotFound what="This repository is not registered." />;
  if (infoError) return <FullScreenMessage title="This repository cannot be opened" detail={infoError.message} retry={() => void cache.getState().load()} />;
  if (!info || !graphs) return <FullScreenMessage title="Loading…" />;
  if (route.kind === "repo") {
    // `/r/<repoId>` → the repository's last graph, else its first; with no graph, the empty editor.
    const last = lastGraphId(repoId);
    const target = graphs.find((g) => g.id === last)?.id ?? graphs[0]?.id ?? null;
    if (target) return <Redirect to={webRoutes.graph(repoId, target)} />;
  }
  return <RouteViews route={route} own={own} active={active} />;
}

function Redirect({ to }: { to: string }) {
  const { navigate } = useLocation();
  useEffect(() => navigate(to, { replace: true }), [to, navigate]);
  return null;
}

interface OwnStores {
  api: ViewStores["api"];
  run: RunStoreApi;
  ui: ViewStores["ui"];
}

/** The editor store shown by a view: the shared one of `graphId`, a placeholder until acquired, an empty one without a graph. */
function useEditorSlot(repoId: string, graphId: string | null): EditorStoreApi {
  const phase = useDaemonStore((s) => s.info?.phase ?? 1);
  const supportedNodeTypes = useDaemonStore((s) => s.info?.supportedNodeTypes ?? null);
  const placeholder = useMemo(() => createEditorStore(repoId, graphId, { validation: { phase, supportedNodeTypes } }), [repoId, graphId, phase, supportedNodeTypes]);
  const [held, setHeld] = useState<{ key: string; store: EditorStoreApi } | null>(null);
  const key = `${repoId}:${graphId ?? ""}`;
  useEffect(() => {
    if (!graphId) return;
    const handle = acquireEditorStore(repoId, graphId, { validation: { phase, supportedNodeTypes } });
    setHeld({ key: `${repoId}:${graphId}`, store: handle.store });
    return () => void handle.release();
  }, [repoId, graphId, phase, supportedNodeTypes]);
  return held?.key === key ? held.store : placeholder;
}

function RouteViews({ route, own, active }: { route: RepoRoute; own: OwnStores; active: boolean }) {
  const { repoId } = route;
  const location = useLocation();
  const runId = routeRunId(route);
  const routeGraphId = route.kind === "graph" ? route.graphId : null;
  const nodeRunId = route.kind === "nodeRun" ? route.nodeRunId : null;
  // A run's graph: from its detail, or from the history list while the detail loads (no flicker between views).
  const runGraphId = useStore(own.run, (s) => (runId ? (s.detail?.run.id === runId ? s.detail.run.graphId : (s.runs.find((r) => r.id === runId)?.graphId ?? null)) : null));
  const graphId = routeGraphId ?? runGraphId;
  const editor = useEditorSlot(repoId, graphId);
  const stores: ViewStores = useMemo(() => ({ repoId, ...own, editor, active }), [repoId, own, editor, active]);
  const view: View = useMemo(() => ({ ...stores, navigate: location.navigate, openInNewTab: location.openInNewTab }), [stores, location.navigate, location.openInNewTab]);

  // The route selects the run (and subscribes to it), or returns to edit mode.
  useEffect(() => {
    void own.run.getState().selectRun(runId);
  }, [own, runId]);

  // The history on the left is the shown graph's.
  useEffect(() => {
    if (graphId && own.run.getState().graphId !== graphId) void own.run.getState().loadRuns(graphId).catch(() => undefined);
  }, [own, graphId]);

  // Opening another graph closes the terminals of the previous one.
  const lastGraph = useRef<string | null>(null);
  useEffect(() => {
    if (!graphId) return;
    if (lastGraph.current && lastGraph.current !== graphId) closeAllTerminals(view);
    lastGraph.current = graphId;
  }, [graphId, view]);

  const hasGraph = useStore(editor, (s) => s.graph !== null);
  useEffect(() => {
    if (graphId && hasGraph) rememberGraph(repoId, graphId);
  }, [repoId, graphId, hasGraph]);

  // `/nodes/<nodeRunId>`: select that node run once the run is loaded; leaving it deselects.
  const detailLoaded = useStore(own.run, (s) => s.detail !== null && s.detail.run.id === runId);
  const shownNodeRun = useRef<string | null>(null);
  useEffect(() => {
    if (!detailLoaded) return;
    if (nodeRunId) {
      const nodeRun = own.run.getState().detail?.nodeRuns.find((n) => n.id === nodeRunId);
      if (nodeRun && shownNodeRun.current !== nodeRunId) showNodeRun(view, nodeRun);
    } else if (shownNodeRun.current) {
      // Deselect only if the selection is still that node run's: clicking a step with no node run selects it
      // and navigates to the run route in one go, and that selection must survive.
      const runs = own.run.getState();
      const prev = runs.detail?.nodeRuns.find((n) => n.id === shownNodeRun.current);
      if (runs.selectedNodeId === prev?.nodeId) runs.selectNode(null);
    }
    shownNodeRun.current = nodeRunId;
  }, [detailLoaded, nodeRunId, own, view]);

  const graphNotFound = useStore(editor, (s) => s.notFound);
  const runNotFound = useStore(own.run, (s) => s.detailNotFound && s.selectedRunId === runId);
  const nodeRunMissing = useStore(own.run, (s) => !!nodeRunId && s.detail?.run.id === runId && !s.detail.nodeRuns.some((n) => n.id === nodeRunId));

  let content: ReactNode = <Workspace route={route} />;
  if (route.kind === "graph" && graphNotFound) content = <NotFound what="This graph does not exist." repoId={repoId} />;
  else if (runNotFound) content = <NotFound what="This run does not exist in this repository." repoId={repoId} />;
  else if (nodeRunMissing) content = <NotFound what="This step does not exist in this run." repoId={repoId} />;
  return <ViewProvider value={stores}>{content}</ViewProvider>;
}
