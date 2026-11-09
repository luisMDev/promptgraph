import type { GraphOverview, RepoSummary } from "@promptgraph/shared";
import { useEffect, useMemo, useState } from "react";
import { repoApi } from "../../api/rest";
import { useDaemonStore } from "../../store/daemon-store";
import { lastGraphId } from "../../store/view/actions";
import { useTabContext } from "../tabs/tab-context";
import { useOverviewQuery } from "./parts";

/** One graph of one repository, as the overview shows it. */
export interface OverviewItem {
  key: string;
  repo: RepoSummary;
  graph: GraphOverview;
  /** Newest of its last run's start and its file's last change (ms). */
  activity: number;
  /** The repository's last opened graph (`pg.lastGraph.<repoId>`). */
  lastOpened: boolean;
}

export type GroupMode = "recent" | "repo" | "none";

export interface OverviewGroup {
  key: string;
  label: string;
  /** The group's repository when grouped by repository. */
  repo?: RepoSummary;
  items: OverviewItem[];
}

/**
 * The graph overviews of every available repository (`GET …/graph-overviews`, plain GETs that never activate a
 * repository), refetched when a repository's summary changes (a run starting, finishing or waiting, a repository added
 * or removed), when the tab becomes visible again, after a reconnect and on `reload()` (after a graph is deleted).
 * A failed refetch keeps what it had.
 */
export function useAllOverviews(repos: RepoSummary[] | null): { byRepo: Map<string, GraphOverview[]>; loading: boolean; reload: () => void } {
  const [byRepo, setByRepo] = useState<Map<string, GraphOverview[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const tabActive = useTabContext()?.active ?? true;
  const online = useDaemonStore((s) => s.connection !== "reconnecting" && s.connection !== "unreachable");
  const key = (repos ?? []).map((r) => `${r.id}:${r.available}:${r.lastRunAt}:${r.runs.running}:${r.runs.paused}:${r.waiting.approval}:${r.waiting.input}`).join("|");
  useEffect(() => {
    if (!repos || !tabActive || !online) return;
    let cancelled = false;
    const available = repos.filter((r) => r.available);
    void Promise.all(
      available.map((r) =>
        repoApi(r.id)
          .listGraphOverviews()
          .then(
            (res) => [r.id, res.graphs] as const,
            () => null,
          ),
      ),
    ).then((results) => {
      if (cancelled) return;
      setByRepo((prev) => {
        const next = new Map<string, GraphOverview[]>();
        for (const r of available) {
          const fresh = results.find((x) => x?.[0] === r.id);
          const graphs = fresh ? fresh[1] : prev.get(r.id);
          if (graphs) next.set(r.id, graphs);
        }
        return next;
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for `repos`' relevant fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tabActive, online, generation]);
  return { byRepo, loading: loading && repos !== null, reload: () => setGeneration((g) => g + 1) };
}

export function activityOf(graph: GraphOverview): number {
  return Math.max(graph.updatedAt, graph.runs.lastRun?.startedAt ?? 0);
}

/** Every graph of the given repositories, newest activity first. */
export function toItems(repos: RepoSummary[], byRepo: Map<string, GraphOverview[]>): OverviewItem[] {
  const items: OverviewItem[] = [];
  for (const repo of repos) {
    const last = lastGraphId(repo.id);
    for (const graph of byRepo.get(repo.id) ?? []) {
      items.push({ key: `${repo.id}/${graph.id}`, repo, graph, activity: activityOf(graph), lastOpened: graph.id === last });
    }
  }
  return items.sort((a, b) => b.activity - a.activity);
}

/** Case-insensitive match on the graph's name and id and the repository's name. */
export function matches(item: OverviewItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.graph.name ?? "", item.graph.id, item.repo.name].some((s) => s.toLowerCase().includes(q));
}

const DAY = 24 * 60 * 60 * 1000;

function recencyBucket(ms: number, now: number): { key: string; label: string } {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return { key: "0", label: "Today" };
  if (ms >= startOfToday - DAY) return { key: "1", label: "Yesterday" };
  if (ms >= startOfToday - 7 * DAY) return { key: "2", label: "Previous 7 days" };
  if (ms >= startOfToday - 30 * DAY) return { key: "3", label: "Previous 30 days" };
  return { key: "4", label: "Older" };
}

/** Groups items (already newest first): by recency bucket, by repository (repositories in `repos` order), or one group. */
export function groupItems(items: OverviewItem[], mode: GroupMode, repos: RepoSummary[], now = Date.now()): OverviewGroup[] {
  if (mode === "none") return [{ key: "all", label: "All graphs", items }];
  if (mode === "repo") {
    return repos.map((repo) => ({ key: repo.id, label: repo.name, repo, items: items.filter((i) => i.repo.id === repo.id) })).filter((g) => g.items.length > 0);
  }
  const groups = new Map<string, OverviewGroup>();
  for (const item of items) {
    const b = recencyBucket(item.activity, now);
    const g = groups.get(b.key) ?? { key: b.key, label: b.label, items: [] };
    g.items.push(item);
    groups.set(b.key, g);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const GROUP_KEY = "pg.overview.group";

/** The group mode, remembered per browser. */
export function useGroupMode(): [GroupMode, (m: GroupMode) => void] {
  const [mode, setMode] = useState<GroupMode>(() => {
    try {
      const v = localStorage.getItem(GROUP_KEY);
      return v === "repo" || v === "none" ? v : "recent";
    } catch {
      return "recent";
    }
  });
  const set = (m: GroupMode) => {
    setMode(m);
    try {
      localStorage.setItem(GROUP_KEY, m);
    } catch {
      // Per-browser convenience only.
    }
  };
  return [mode, set];
}

/** Everything a layout needs: the repositories, the filtered items, their groups and the per-repository counts. */
export interface OverviewModel {
  repos: RepoSummary[] | null;
  reposError: string | null;
  /** The repository filter (the route): null = every repository. */
  repoId: string | null;
  repo: RepoSummary | null;
  loading: boolean;
  /** Every graph (unfiltered), newest first. */
  all: OverviewItem[];
  /** After the repository filter and the search. */
  items: OverviewItem[];
  groups: OverviewGroup[];
  countByRepo: Map<string, number>;
  query: string;
  setQuery: (q: string) => void;
  /** The grouping shown: the remembered mode under All graphs, "none" inside one repository. */
  group: GroupMode;
  setGroup: (m: GroupMode) => void;
  /** Refetches every repository's graphs. */
  reload: () => void;
}

export function useOverviewModel(repoId: string | null): OverviewModel {
  const repos = useDaemonStore((s) => s.repos);
  const reposError = useDaemonStore((s) => s.reposError);
  const { byRepo, loading, reload } = useAllOverviews(repos);
  const query = useOverviewQuery((s) => s.query);
  const setQuery = useOverviewQuery((s) => s.setQuery);
  const [group, setGroup] = useGroupMode();
  const all = useMemo(() => toItems(repos ?? [], byRepo), [repos, byRepo]);
  const items = useMemo(() => all.filter((i) => (repoId === null || i.repo.id === repoId) && matches(i, query)), [all, repoId, query]);
  // Inside one repository the graphs are not grouped (newest activity first).
  const shownGroup: GroupMode = repoId === null ? group : "none";
  const groups = useMemo(() => groupItems(items, shownGroup, repos ?? []), [items, shownGroup, repos]);
  const countByRepo = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) m.set(i.repo.id, (m.get(i.repo.id) ?? 0) + 1);
    return m;
  }, [all]);
  return {
    repos,
    reposError,
    repoId,
    repo: repos?.find((r) => r.id === repoId) ?? null,
    loading,
    all,
    items,
    groups,
    countByRepo,
    query,
    setQuery,
    group: shownGroup,
    setGroup,
    reload,
  };
}
