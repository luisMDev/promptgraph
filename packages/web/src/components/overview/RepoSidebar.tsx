import type { RepoSummary } from "@promptgraph/shared";
import { StarIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { create } from "zustand";
import { cn } from "@/lib/utils";
import { Link } from "../../lib/router/Link";
import { Icons } from "../common/icons";
import { Logo } from "../common/Logo";
import { TAB_DRAG_THRESHOLD, TAB_SLIDE_MS, tabDragTarget, tabGap, tabShift, type TabSlot } from "../tabs/TabStrip";
import type { OverviewModel } from "./data";
import { filterHref, RepoAvatar, RepoPulse } from "./parts";
import { arrangeRepos, clampSidebarWidth, moveRepo, positionOf, SIDEBAR_DEFAULT } from "./sidebar-order";

// --- Preferences, remembered per browser ------------------------------------------------------------------------------

const KEYS = { order: "pg.overview.sidebar.order", favorites: "pg.overview.sidebar.favorites", width: "pg.overview.sidebar.width" } as const;

function readList(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(KEYS.width));
    return v ? clampSidebarWidth(v) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Per-browser convenience only.
  }
}

interface SidebarPrefs {
  order: string[];
  favorites: string[];
  width: number;
  setOrder: (order: string[]) => void;
  toggleFavorite: (id: string) => void;
  setWidth: (px: number) => void;
}

export const useSidebarPrefs = create<SidebarPrefs>((set, get) => ({
  order: readList(KEYS.order),
  favorites: readList(KEYS.favorites),
  width: readWidth(),
  setOrder: (order) => {
    write(KEYS.order, order);
    set({ order });
  },
  toggleFavorite: (id) => {
    const favorites = get().favorites.includes(id) ? get().favorites.filter((x) => x !== id) : [...get().favorites, id];
    write(KEYS.favorites, favorites);
    set({ favorites });
  },
  setWidth: (px) => {
    const width = clampSidebarWidth(px);
    write(KEYS.width, String(width));
    set({ width });
  },
}));

/** Reloads the preferences from storage (tests reset `localStorage` between cases). */
export function reloadSidebarPrefs(): void {
  useSidebarPrefs.setState({ order: readList(KEYS.order), favorites: readList(KEYS.favorites), width: readWidth() });
}

// --- The column ---------------------------------------------------------------------------------------------------------

/**
 * The overview's repositories column (DESIGN §13.3): All graphs, then **Favorites** and **Repositories**. Hovering a
 * repository shows a star that moves it to (or back from) Favorites; rows are reordered within their section by
 * dragging them, as the tabs are, or with Alt+↑/↓; the right edge resizes the column. Order, favourites and width are
 * remembered per browser.
 */
export function RepoSidebar({ m, onAddRepo }: { m: OverviewModel; onAddRepo: () => void }) {
  const order = useSidebarPrefs((s) => s.order);
  const favorites = useSidebarPrefs((s) => s.favorites);
  const width = useSidebarPrefs((s) => s.width);
  const setOrder = useSidebarPrefs((s) => s.setOrder);
  const arranged = useMemo(() => arrangeRepos(m.repos ?? [], order, favorites), [m.repos, order, favorites]);
  const move = (id: string, to: number) => setOrder(moveRepo(arranged, id, to));

  return (
    <div style={{ width }} className="relative flex shrink-0">
      <aside aria-label="Repositories" className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto bg-muted/25 px-2 py-3">
      <div className="mb-3 flex items-center gap-2 px-2">
        <Logo size={18} />
        <span className="text-sm font-semibold tracking-tight">promptgraph</span>
      </div>
      <Link
        to={filterHref(null)}
        aria-current={m.repoId === null ? "page" : undefined}
        className={cn("flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors", m.repoId === null ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}
      >
        <Icons.layers className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">All graphs</span>
        <span className="text-[11px] tabular-nums opacity-70">{m.all.length}</span>
      </Link>
      {arranged.favorites.length > 0 && (
        <Section title="Favorites" repos={arranged.favorites} m={m} onMove={move} arranged={arranged} />
      )}
      <Section title="Repositories" repos={arranged.others} m={m} onMove={move} arranged={arranged} />
      <button type="button" onClick={onAddRepo} className="mt-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground">
        <Icons.plus /> Add repository
      </button>
      </aside>
      <ResizeHandle />
    </div>
  );
}

function Section({ title, repos, m, onMove, arranged }: { title: string; repos: RepoSummary[]; m: OverviewModel; onMove: (id: string, to: number) => void; arranged: ReturnType<typeof arrangeRepos> }) {
  const listRef = useRef<HTMLUListElement>(null);
  const drag = useRowDrag(listRef, onMove);
  const onKeyDown = (id: string, e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const pos = positionOf(arranged, id);
    if (!pos) return;
    e.preventDefault();
    const to = pos.index + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= repos.length) return;
    onMove(id, to);
    // Keep the focus on the moved row.
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-repo-id="${CSS.escape(id)}"] a`)?.focus());
  };
  if (repos.length === 0 && title === "Favorites") return null;
  return (
    <>
      <p className="mt-4 mb-1 px-2 text-[11px] font-medium text-muted-foreground">{title}</p>
      <ul ref={listRef} aria-label={title} className="flex flex-col gap-0.5">
        {repos.map((r, i) => (
          <RepoRow
            key={r.id}
            repo={r}
            index={i}
            active={m.repoId === r.id}
            count={m.countByRepo.get(r.id) ?? 0}
            drag={drag}
            onKeyDown={(e) => onKeyDown(r.id, e)}
          />
        ))}
      </ul>
    </>
  );
}

function RepoRow({
  repo,
  index,
  active,
  count,
  drag,
  onKeyDown,
}: {
  repo: RepoSummary;
  index: number;
  active: boolean;
  count: number;
  drag: RowDrag;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const favorite = useSidebarPrefs((s) => s.favorites.includes(repo.id));
  const toggleFavorite = useSidebarPrefs((s) => s.toggleFavorite);
  const style = drag.styleOf(repo.id, index);
  return (
    <li
      data-repo-id={repo.id}
      onPointerDown={(e) => drag.onPointerDown(repo.id, e)}
      onClickCapture={drag.suppressClick}
      style={{ transform: style.offset ? `translateY(${style.offset}px)` : undefined }}
      className={cn(
        "group relative touch-none rounded-sm",
        style.animate && "transition-transform duration-150 ease-out motion-reduce:transition-none",
        style.lifted && "z-10 cursor-grabbing bg-background shadow-md ring-1 ring-border",
      )}
    >
      <Link
        to={filterHref(repo.id)}
        draggable={false}
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onKeyDown={onKeyDown}
        className={cn(
          "flex items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-xs transition-colors select-none",
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <RepoAvatar repo={repo} size="sm" />
        <span className="min-w-0 flex-1 truncate">{repo.name}</span>
        <RepoPulse repo={repo} />
      </Link>
      {/* The count, replaced by the star on hover or focus. */}
      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums opacity-70 group-focus-within:hidden group-hover:hidden">
        {count}
      </span>
      <button
        type="button"
        aria-label={favorite ? `Remove ${repo.name} from favorites` : `Add ${repo.name} to favorites`}
        aria-pressed={favorite}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(repo.id)}
        className="absolute top-1/2 right-1 hidden size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground group-focus-within:flex group-hover:flex hover:bg-accent hover:text-foreground"
      >
        <StarIcon className={cn("size-3.5", favorite && "fill-amber-400 text-amber-500")} />
      </button>
    </li>
  );
}

// --- Drag to reorder (the tabs' drag, vertical) -------------------------------------------------------------------------

interface DragView {
  id: string;
  from: number;
  to: number;
  dy: number;
  height: number;
  phase: "drag" | "return" | "settle";
  animate: boolean;
}

interface RowStyle {
  lifted: boolean;
  animate: boolean;
  offset: number;
}

interface RowDrag {
  styleOf: (id: string, index: number) => RowStyle;
  onPointerDown: (id: string, e: ReactPointerEvent<HTMLElement>) => void;
  /** Swallows the click that ends a drag, so dropping a row does not also open it. */
  suppressClick: (e: MouseEvent) => void;
}

const REST: RowStyle = { lifted: false, animate: false, offset: 0 };

/**
 * Drag to reorder a section's rows, as the tab strip does (pointer events; the tab strip's pure `tabDragTarget`,
 * `tabGap` and `tabShift` with tops and heights instead of lefts and widths). Past the threshold the row is lifted
 * and follows the pointer while the others slide aside; the order changes on release and the row slides into its
 * slot; Escape slides it back.
 */
function useRowDrag(listRef: RefObject<HTMLUListElement | null>, onDrop: (id: string, to: number) => void): RowDrag {
  const [view, setView] = useState<DragView | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const timers = useRef<number[]>([]);
  const dragged = useRef(false);

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };
  useEffect(
    () => () => {
      stop.current?.();
      clearTimers();
    },
    [],
  );
  const finishLater = () => timers.current.push(window.setTimeout(() => setView(null), TAB_SLIDE_MS + 30));

  const onPointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.isPrimary === false || (e.target as HTMLElement).closest("button")) return;
    stop.current?.();
    clearTimers();
    setView(null);
    dragged.current = false;
    const { pointerId, clientY: startY } = e;
    let slots: TabSlot[] | null = null;
    let from = -1;
    let current = { dx: 0, to: -1 };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!slots) {
        if (Math.abs(ev.clientY - startY) < TAB_DRAG_THRESHOLD) return;
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>(":scope > [data-repo-id]") ?? [])];
        from = items.findIndex((el) => el.dataset.repoId === id);
        if (from === -1) return finish("cancel");
        slots = items.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.top, width: r.height };
        });
        dragged.current = true;
      }
      current = tabDragTarget(slots, from, ev.clientY - startY);
      setView({ id, from, to: current.to, dy: current.dx, height: slots[from]!.width + tabGap(slots), phase: "drag", animate: false });
    };

    const finish = (how: "drop" | "cancel") => {
      const measured = slots;
      stop.current?.();
      if (!measured) return;
      const gap = tabGap(measured);
      const height = measured[from]!.width + gap;
      if (how === "cancel" || current.to === from) {
        setView({ id, from, to: from, dy: 0, height, phase: "return", animate: true });
        finishLater();
        return;
      }
      const between = current.to > from ? measured.slice(from + 1, current.to + 1) : measured.slice(current.to, from);
      const travel = between.reduce((sum, slot) => sum + slot.width + gap, 0) * (current.to > from ? 1 : -1);
      onDrop(id, current.to);
      setView({ id, from: current.to, to: current.to, dy: current.dx - travel, height, phase: "settle", animate: false });
      requestAnimationFrame(() => requestAnimationFrame(() => setView((v) => (v?.phase === "settle" ? { ...v, dy: 0, animate: true } : v))));
      finishLater();
    };

    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(ev.type === "pointercancel" ? "cancel" : "drop");
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || !slots) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish("cancel");
    };
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", onKey, true);
      stop.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", onKey, true);
  };

  const styleOf = (id: string, index: number): RowStyle => {
    if (!view) return REST;
    if (id === view.id) return { lifted: view.phase === "drag", animate: view.animate, offset: view.dy };
    if (view.phase === "settle") return REST;
    return { lifted: false, animate: true, offset: tabShift(index, view.from, view.to, view.height) };
  };

  const suppressClick = (e: MouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { styleOf, onPointerDown, suppressClick };
}

// --- Resize ---------------------------------------------------------------------------------------------------------------

/** The column's right edge: drag to resize, double-click to reset, ←/→ when focused. */
function ResizeHandle() {
  const width = useSidebarPrefs((s) => s.width);
  const setWidth = useSidebarPrefs((s) => s.setWidth);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent) => setWidth(startWidth + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      delete document.documentElement.dataset.pgResizing;
    };
    document.documentElement.dataset.pgResizing = "";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize repositories"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setWidth(width - 16);
        else if (e.key === "ArrowRight") setWidth(width + 16);
      }}
      className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize touch-none outline-none hover:bg-border focus-visible:bg-ring"
    />
  );
}

