/** At most this many tab views are mounted at once (DESIGN §13.4 Keep-alive). */
export const MAX_MOUNTED = 6;

/**
 * The tab views to keep mounted: the ones mounted before that still exist, plus the active one (mounted
 * on its first activation), minus the least recently used ones beyond `max`. The active view and views
 * that are `pinned` (an editor with unsaved or in-flight changes) are never evicted, so the result may
 * exceed `max` while every candidate is pinned. Returns `mounted` itself when nothing changes.
 */
export function planMounted(
  mounted: readonly string[],
  opts: { tabIds: readonly string[]; activeId: string; mru: readonly string[]; pinned: (tabId: string) => boolean; max?: number },
): readonly string[] {
  const max = opts.max ?? MAX_MOUNTED;
  const exists = new Set(opts.tabIds);
  let next = mounted.filter((id) => exists.has(id));
  if (!next.includes(opts.activeId) && exists.has(opts.activeId)) next = [...next, opts.activeId];
  const rank = (id: string) => {
    const i = opts.mru.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  while (next.length > max) {
    const victim = next
      .filter((id) => id !== opts.activeId && !opts.pinned(id))
      .sort((a, b) => rank(b) - rank(a))[0];
    if (!victim) break;
    next = next.filter((id) => id !== victim);
  }
  return next.length === mounted.length && next.every((id, i) => id === mounted[i]) ? mounted : next;
}
