import type { RepoSummary } from "@promptgraph/shared";

/** The repositories column's sections, in display order (DESIGN §13.3). */
export interface ArrangedRepos {
  favorites: RepoSummary[];
  others: RepoSummary[];
}

/**
 * Splits the repositories into favourites and the rest, each in the user's order (`order`, repository ids); a
 * repository the user has not placed comes after the placed ones, in the daemon's order. Unknown ids are ignored.
 */
export function arrangeRepos(repos: readonly RepoSummary[], order: readonly string[], favorites: readonly string[]): ArrangedRepos {
  const rank = new Map(order.map((id, i) => [id, i]));
  const sorted = repos
    .map((repo, i) => ({ repo, key: rank.get(repo.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.repo);
  const fav = new Set(favorites);
  return { favorites: sorted.filter((r) => fav.has(r.id)), others: sorted.filter((r) => !fav.has(r.id)) };
}

/** The full order after moving `id` to index `to` of its own section (pure). */
export function moveRepo(arranged: ArrangedRepos, id: string, to: number): string[] {
  const ids = (list: RepoSummary[]) => list.map((r) => r.id);
  const move = (list: string[]) => {
    const from = list.indexOf(id);
    if (from === -1) return list;
    const next = list.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
    return next;
  };
  return [...move(ids(arranged.favorites)), ...move(ids(arranged.others))];
}

/** Section and index of `id`, or null. */
export function positionOf(arranged: ArrangedRepos, id: string): { section: "favorites" | "others"; index: number } | null {
  const f = arranged.favorites.findIndex((r) => r.id === id);
  if (f !== -1) return { section: "favorites", index: f };
  const o = arranged.others.findIndex((r) => r.id === id);
  return o === -1 ? null : { section: "others", index: o };
}

/** The repositories column's width bounds and default (px). */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 240;

export function clampSidebarWidth(px: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
}
