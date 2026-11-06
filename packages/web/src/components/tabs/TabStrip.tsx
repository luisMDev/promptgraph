import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { getDesktopBridge, type DesktopBridge, type ResizeDirection } from "../../lib/desktop";
import { HOME_PATH, activeTab, tabsStore, useTabs, type Tab } from "../../store/tabs-store";
import { Icons } from "../common/icons";
import { Logo } from "../common/Logo";
import { useLoadTabRepos, useTabAttention, useTabTitle } from "./use-tab-title";

/**
 * The in-app tab strip at the top of the page (DESIGN §13.4): the app logo first (it activates Home), then
 * title, attention dot and close button per tab, middle-click closes, "+" opens Home in a new tab. Tabs are
 * reordered by dragging them, or with Ctrl+Shift+Left/Right on the focused tab. It scrolls horizontally when
 * the tabs overflow and keeps the active one in view. `role=tablist` with roving focus (arrows, Home/End).
 *
 * In the desktop window with a custom title bar (DESIGN §20.2) the strip is the title bar:
 * `data-tauri-drag-region` sits on the strip's own element and on the flex-1 spacer only (the attribute does
 * not apply to children, so never on the tab list, which tabs cover); Tauri's drag script handles dragging
 * and double-click-to-maximise. Window controls sit at the right end and thin edge handles resize the window.
 * With native decorations, or in a browser, none of this renders.
 */
export function TabStrip({ bridge = getDesktopBridge() }: { bridge?: DesktopBridge }) {
  const titleBar = bridge.isDesktop && bridge.customTitleBar;
  const dragRegion = titleBar ? { "data-tauri-drag-region": "" } : {};
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useTabDrag(listRef);
  useLoadTabRepos(tabs);

  useEffect(() => {
    const items = listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [];
    const el = [...items].find((item) => item.dataset.tabId === activeId);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const id = items[at]!.dataset.tabId!;
      tabsStore().getState().move(id, at + (e.key === "ArrowRight" ? 1 : -1));
      // Moving the element in the DOM can drop its focus: focus it again once React has re-rendered.
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus());
      return;
    }
    let to: number | null = null;
    if (e.key === "ArrowRight") to = (at + 1) % items.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    if (to === null) return;
    e.preventDefault();
    items[to]!.focus();
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-1.5 text-xs select-none" data-pg-tabstrip="" {...dragRegion}>
      <button
        type="button"
        aria-label="promptgraph Home"
        title="Home"
        className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-foreground hover:bg-accent/60"
        onClick={() => tabsStore().getState().open(HOME_PATH, { activate: true })}
      >
        <Logo size={18} />
        <span className="text-[13px] font-semibold tracking-tight">promptgraph</span>
      </button>
      <div ref={listRef} role="tablist" aria-label="Tabs" className="pg-tab-list flex min-w-0 items-center gap-1 overflow-x-auto py-0.5" onKeyDown={onKeyDown}>
        {tabs.map((tab, i) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            dragging={drag.draggingId === tab.id}
            dragStyle={drag.styleOf(tab.id, i)}
            onPointerDown={drag.onPointerDown}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => tabsStore().getState().open(HOME_PATH, { activate: true, dedupe: false })}
      >
        <Icons.plus />
      </button>
      <div className="min-w-6 flex-1" data-pg-tabstrip-spacer="" {...dragRegion} />
      {titleBar && <WindowFrame bridge={bridge} />}
      <DocumentTitle bridge={bridge} />
    </div>
  );
}

/** Pointer movement (px) after which a pressed tab is dragged rather than clicked. */
export const TAB_DRAG_THRESHOLD = 5;
/** Length of the slide animations (ms); keep in sync with the `duration-150` class. */
export const TAB_SLIDE_MS = 150;

/** A tab's horizontal box when the drag started. */
export interface TabSlot {
  left: number;
  width: number;
}

/**
 * Where the dragged tab is shown and which slot it takes (pure). `dx` is clamped so the tab stays inside the
 * strip; the tab takes a neighbour's slot once its leading edge passes that neighbour's middle, as in a
 * browser's tab strip.
 */
export function tabDragTarget(slots: readonly TabSlot[], from: number, rawDx: number): { dx: number; to: number } {
  const self = slots[from]!;
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;
  const dx = Math.min(Math.max(rawDx, first.left - self.left), last.left + last.width - (self.left + self.width));
  const middle = (slot: TabSlot) => slot.left + slot.width / 2;
  if (dx >= 0) {
    const edge = self.left + self.width + dx;
    return { dx, to: from + slots.slice(from + 1).filter((slot) => middle(slot) < edge).length };
  }
  const edge = self.left + dx;
  return { dx, to: from - slots.slice(0, from).filter((slot) => middle(slot) > edge).length };
}

/** The space between two tabs of the strip (they are separate pills), from the boxes measured at drag start. */
export function tabGap(slots: readonly TabSlot[]): number {
  if (slots.length < 2) return 0;
  return Math.max(0, slots[1]!.left - (slots[0]!.left + slots[0]!.width));
}

/** How far the tab at strip index `i` moves aside while the tab at `from` (`width` wide) hovers over `to` (pure). */
export function tabShift(i: number, from: number, to: number, width: number): number {
  if (from < to && i > from && i <= to) return -width;
  if (to < from && i >= to && i < from) return width;
  return 0;
}

/** Drag state the strip renders: `drag` follows the pointer, `return` slides back (cancelled), `settle` slides into the new slot. */
interface TabDragView {
  id: string;
  from: number;
  to: number;
  /** Dragged tab's offset from its slot (drag, return) or from its new slot (settle). */
  dx: number;
  width: number;
  phase: "drag" | "return" | "settle";
  /** The dragged tab's offset transitions (return, and settle once its start offset is painted). */
  animate: boolean;
}

/** Per-tab presentation during a drag. */
export interface TabDragStyle {
  lifted: boolean;
  /** The transform transitions (neighbours sliding aside, the dragged tab sliding into place). */
  animate: boolean;
  offset: number;
}

const REST: TabDragStyle = { lifted: false, animate: false, offset: 0 };

/**
 * Drag to reorder (pointer events, so it works the same in a browser and in the desktop window, where the
 * strip is the title bar but the tabs are not drag regions). Past TAB_DRAG_THRESHOLD the pressed tab is
 * activated and lifted: it follows the pointer while the others slide aside to show where it will land. The
 * strip order changes once, on release, and the tab then slides into its slot. Escape (or a cancelled
 * pointer) slides it back. Nothing moves in the DOM until the drop, so focus and scroll are not disturbed.
 */
function useTabDrag(listRef: RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState<TabDragView | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const timeouts = useRef<number[]>([]);
  const frames = useRef<number[]>([]);

  const clearTimers = () => {
    for (const t of timeouts.current) clearTimeout(t);
    for (const f of frames.current) cancelAnimationFrame(f);
    timeouts.current = [];
    frames.current = [];
  };

  useEffect(
    () => () => {
      stop.current?.();
      clearTimers();
    },
    [],
  );

  /** Ends a return or settle animation. */
  const finishLater = () => {
    timeouts.current.push(window.setTimeout(() => setView(null), TAB_SLIDE_MS + 30));
  };

  const onPointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.isPrimary === false || (e.target as HTMLElement).closest("button")) return;
    stop.current?.();
    clearTimers();
    setView(null);
    const { pointerId, clientX: startX } = e;
    let slots: TabSlot[] | null = null;
    let from = -1;
    let current: { dx: number; to: number } = { dx: 0, to: -1 };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!slots) {
        if (Math.abs(ev.clientX - startX) < TAB_DRAG_THRESHOLD) return;
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])];
        from = items.findIndex((el) => el.dataset.tabId === id);
        if (from === -1) return finish("cancel");
        slots = items.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, width: r.width };
        });
        tabsStore().getState().activate(id);
        document.documentElement.dataset.pgTabDragging = "";
      }
      current = tabDragTarget(slots, from, ev.clientX - startX);
      setView({ id, from, to: current.to, dx: current.dx, width: slots[from]!.width + tabGap(slots), phase: "drag", animate: false });
    };

    const finish = (how: "drop" | "cancel") => {
      const dragged = slots;
      stop.current?.();
      if (!dragged) return;
      const gap = tabGap(dragged);
      const width = dragged[from]!.width + gap;
      if (how === "cancel" || current.to === from) {
        // Slide back to the original slot.
        setView({ id, from, to: from, dx: 0, width, phase: "return", animate: true });
        finishLater();
        return;
      }
      // Reorder now; the tab is first drawn where it was dropped, then slides into its new slot.
      const between = current.to > from ? dragged.slice(from + 1, current.to + 1) : dragged.slice(current.to, from);
      const travel = between.reduce((sum, slot) => sum + slot.width + gap, 0) * (current.to > from ? 1 : -1);
      tabsStore().getState().move(id, current.to);
      setView({ id, from: current.to, to: current.to, dx: current.dx - travel, width, phase: "settle", animate: false });
      // Two frames: the start offset must be painted before the transition is switched on.
      frames.current.push(
        requestAnimationFrame(() => {
          frames.current.push(requestAnimationFrame(() => setView((v) => (v?.phase === "settle" ? { ...v, dx: 0, animate: true } : v))));
        }),
      );
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
      delete document.documentElement.dataset.pgTabDragging;
      stop.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", onKey, true);
  };

  /** Presentation of the tab with `id`, at strip index `index`. */
  const styleOf = (id: string, index: number): TabDragStyle => {
    if (!view) return REST;
    if (id === view.id) return { lifted: view.phase === "drag", animate: view.animate, offset: view.dx };
    // After the drop the strip order already matches the slots: the others rest where they are.
    if (view.phase === "settle") return REST;
    return { lifted: false, animate: true, offset: tabShift(index, view.from, view.to, view.width) };
  };

  return { draggingId: view?.phase === "drag" ? view.id : null, styleOf, onPointerDown };
}

function TabItem({
  tab,
  active,
  dragging,
  dragStyle,
  onPointerDown,
}: {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  dragStyle: TabDragStyle;
  onPointerDown: (id: string, e: ReactPointerEvent<HTMLElement>) => void;
}) {
  const title = useTabTitle(tab);
  const attention = useTabAttention(tab);
  const store = tabsStore();
  const onAuxClick = (e: MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    store.getState().close(tab.id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      store.getState().activate(tab.id);
    } else if (e.key === "Delete") {
      e.preventDefault();
      store.getState().close(tab.id);
    }
  };
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      data-dragging={dragging || undefined}
      title={title}
      className={cn(
        "group relative flex h-7 w-44 min-w-24 shrink items-center gap-1.5 rounded-md pr-1 pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // The active tab is lit (a lighter fill), the others sit dim on the frame.
        active ? "bg-foreground/12 font-medium text-foreground" : "cursor-pointer bg-muted/50 text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
        dragStyle.animate && "transition-transform duration-150 ease-out motion-reduce:transition-none",
        dragStyle.offset !== 0 && "z-[1]",
        // Lifted: above its neighbours, opaque, with a shadow and the grabbing cursor while it follows the pointer.
        dragging && "z-20 cursor-grabbing bg-accent text-foreground shadow-xl shadow-black/25 ring-1 ring-foreground/20 will-change-transform",
      )}
      style={dragStyle.offset !== 0 ? { transform: `translateX(${dragStyle.offset}px)` } : undefined}
      onPointerDown={(e) => onPointerDown(tab.id, e)}
      // A middle press would start autoscroll; the release (auxclick) closes the tab.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onClick={() => store.getState().activate(tab.id)}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
    >
      {attention && <span aria-label="Needs attention" className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
          active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
        )}
        onClick={(e) => {
          e.stopPropagation();
          store.getState().close(tab.id);
        }}
      >
        <Icons.x />
      </button>
    </div>
  );
}

/** The window title follows the active tab (in the desktop window, the native window's title too). */
function DocumentTitle({ bridge }: { bridge: DesktopBridge }) {
  const tab = useTabs(activeTab);
  const title = useTabTitle(tab);
  useEffect(() => {
    const windowTitle = title === "Home" ? "promptgraph" : `${title} · promptgraph`;
    document.title = windowTitle;
    if (bridge.isDesktop) void bridge.setTitle(windowTitle).catch(() => {});
  }, [bridge, title]);
  return null;
}

/**
 * The title bar alone (drag region, window controls and resize edges) for pages without the tab strip,
 * such as the signed-out screen: a window with a custom title bar must stay movable and closable there.
 * Renders nothing in a browser or with native decorations.
 */
export function WindowTitleBar({ bridge = getDesktopBridge() }: { bridge?: DesktopBridge }) {
  if (!bridge.isDesktop || !bridge.customTitleBar) return null;
  return (
    <div className="flex h-10 shrink-0 items-stretch text-xs select-none" data-pg-titlebar="" data-tauri-drag-region="">
      <div className="min-w-6 flex-1" data-tauri-drag-region="" />
      <WindowFrame bridge={bridge} />
    </div>
  );
}

/** Whether the window is maximised, re-queried on every DOM `resize`. */
function useMaximized(bridge: DesktopBridge): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    const query = () => {
      bridge.isMaximized().then(
        (value) => alive && setMaximized(value),
        () => {},
      );
    };
    query();
    window.addEventListener("resize", query);
    return () => {
      alive = false;
      window.removeEventListener("resize", query);
    };
  }, [bridge]);
  return maximized;
}

/** Window controls and resize edges of the custom title bar (DESIGN §20.2). */
function WindowFrame({ bridge }: { bridge: DesktopBridge }) {
  const maximized = useMaximized(bridge);
  const control = "flex w-10 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <>
      <div className="flex shrink-0 items-stretch" data-pg-window-controls="">
        <button type="button" aria-label="Minimize" title="Minimize" className={control} onClick={() => void bridge.minimize().catch(() => {})}>
          <Icons.minimize />
        </button>
        <button
          type="button"
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          className={control}
          onClick={() => void bridge.toggleMaximize().catch(() => {})}
        >
          {maximized ? <Icons.restore /> : <Icons.maximize />}
        </button>
        <button type="button" aria-label="Close window" title="Close" className={cn(control, "hover:bg-red-600 hover:text-white")} onClick={() => void bridge.close().catch(() => {})}>
          <Icons.x />
        </button>
      </div>
      {!maximized && <ResizeEdges bridge={bridge} />}
    </>
  );
}

const EDGE = 4;
const CORNER = 8;
const EDGES: Array<{ direction: ResizeDirection; style: CSSProperties; cursor: string }> = [
  { direction: "North", style: { top: 0, left: CORNER, right: CORNER, height: EDGE }, cursor: "ns-resize" },
  { direction: "South", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE }, cursor: "ns-resize" },
  { direction: "West", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE }, cursor: "ew-resize" },
  { direction: "East", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE }, cursor: "ew-resize" },
  { direction: "NorthWest", style: { top: 0, left: 0, width: CORNER, height: CORNER }, cursor: "nwse-resize" },
  { direction: "SouthEast", style: { bottom: 0, right: 0, width: CORNER, height: CORNER }, cursor: "nwse-resize" },
  { direction: "NorthEast", style: { top: 0, right: 0, width: CORNER, height: CORNER }, cursor: "nesw-resize" },
  { direction: "SouthWest", style: { bottom: 0, left: 0, width: CORNER, height: CORNER }, cursor: "nesw-resize" },
];

/** Thin handles along the window's edges (an undecorated window has no frame to resize by). */
function ResizeEdges({ bridge }: { bridge: DesktopBridge }) {
  return (
    <>
      {EDGES.map(({ direction, style, cursor }) => (
        <div
          key={direction}
          aria-hidden="true"
          data-pg-resize-edge={direction}
          className="fixed z-[60]"
          style={{ ...style, cursor }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void bridge.startResizeDragging(direction).catch(() => {});
          }}
        />
      ))}
    </>
  );
}
