import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { parseRoute } from "../../lib/router/routes";
import { deriveTabTitle } from "../../lib/tabs/titles";
import { useDaemonStore } from "../../store/daemon-store";
import { getRepoCache, type RepoCacheState } from "../../store/repo-cache";
import type { Tab } from "../../store/tabs-store";

/** Stand-in for tabs without a repository (Home) or whose repository was removed. */
const NO_CACHE = createStore<Pick<RepoCacheState, "info" | "graphs">>()(() => ({ info: null, graphs: null }));

function routeRepoId(path: string): string | null {
  const route = parseRoute(path);
  return "repoId" in route ? route.repoId : null;
}

/** The repository of a tab, unless it was removed while the page was open (its cache must not come back). */
function useTabRepo(path: string): { repoId: string | null; removed: boolean } {
  const repoId = routeRepoId(path);
  const removed = useDaemonStore((s) => (repoId ? !!s.removed[repoId] : false));
  return { repoId, removed };
}

/** What the strip shows for a tab: its title from the repository cache and the persisted one (DESIGN §13.4). */
export function useTabTitle(tab: Tab): string {
  const route = useMemo(() => parseRoute(tab.path), [tab.path]);
  const { repoId, removed } = useTabRepo(tab.path);
  const cache = repoId && !removed ? getRepoCache(repoId) : NO_CACHE;
  const cacheName = useStore(cache, (s) => s.info?.name ?? null);
  const graphs = useStore(cache, (s) => s.graphs);
  const summaryName = useDaemonStore((s) => (repoId ? (s.repos?.find((r) => r.id === repoId)?.name ?? s.removed[repoId]?.name ?? null) : null));
  return deriveTabTitle(route, { repoName: summaryName ?? cacheName, graphs }, tab.title);
}

/** Whether the tab's repository has nodes waiting for the user (approval, input or idle). */
export function useTabAttention(tab: Tab): boolean {
  const repoId = routeRepoId(tab.path);
  return useDaemonStore((s) => {
    if (!repoId) return false;
    const summary = s.repos?.find((r) => r.id === repoId);
    return !!summary && summary.waiting.approval + summary.waiting.input > 0;
  });
}

/**
 * Loads the info and graph list of every repository that has a tab (mounted or not), so every title can
 * be derived; a removed repository is skipped.
 */
export function useLoadTabRepos(tabs: readonly Tab[]): void {
  const removed = useDaemonStore((s) => s.removed);
  const key = [...new Set(tabs.map((t) => routeRepoId(t.path)).filter((id): id is string => !!id && !removed[id]))].sort().join("\n");
  useEffect(() => {
    if (!key) return;
    for (const repoId of key.split("\n")) void getRepoCache(repoId).getState().load();
  }, [key]);
}
