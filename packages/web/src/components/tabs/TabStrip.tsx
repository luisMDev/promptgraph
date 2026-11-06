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
    <div className="flex h-9 shrink-0 items-stretch border-b bg-muted/40 text-xs select-none" data-pg-tabstrip="" {...dragRegion}>
      <button
        type="button"
        aria-label="promptgraph Home"
        title="Home"
        className="flex shrink-0 items-center gap-2 border-r px-3 text-foreground hover:bg-accent/60"
        onClick={() => tabsStore().getState().open(HOME_PATH, { activate: true })}
      >
        <Logo size={18} />
        <span className="text-[13px] font-semibold tracking-tight">promptgraph</span>
      </button>
      <div ref={listRef} role="tablist" aria-label="Tabs" className="pg-tab-list flex min-w-0 items-stretch overflow-x-auto" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} active={tab.id === activeId} dragging={drag.draggingId === tab.id} onPointerDown={drag.onPointerDown} />
        ))}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
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

/**
 * Index the dragged tab takes when the pointer is at `x`: the number of other tabs whose middle lies left of
 * it. Pure; `rects` are the other tabs' boxes in strip order.
 */
export function tabDropIndex(rects: readonly Pick<DOMRect, "left" | "width">[], x: number): number {
  return rects.filter((r) => r.left + r.width / 2 < x).length;
}

/**
 * Drag to reorder (pointer events, so it works the same in a browser and in the desktop window, where the
 * strip is the title bar but the tabs are not drag regions). Past TAB_DRAG_THRESHOLD the strip reorders live
 * under the pointer; the click that ends the press activates the tab as usual.
 */
function useTabDrag(listRef: RefObject<HTMLDivElement | null>) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.isPrimary === false || (e.target as HTMLElement).closest("button")) return;
    stop.current?.();
    const { pointerId, clientX: startX } = e;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < TAB_DRAG_THRESHOLD) return;
        dragging = true;
        setDraggingId(id);
      }
      const others = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])].filter((el) => el.dataset.tabId !== id);
      tabsStore().getState().move(id, tabDropIndex(others.map((el) => el.getBoundingClientRect()), ev.clientX));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop.current?.();
    };
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      stop.current = null;
      setDraggingId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return { draggingId, onPointerDown };
}

function TabItem({
  tab,
  active,
  dragging,
  onPointerDown,
}: {
  tab: Tab;
  active: boolean;
  dragging: boolean;
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
        "group relative flex w-44 min-w-24 shrink items-center gap-1.5 border-r pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-background text-foreground" : "cursor-pointer text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        dragging && "z-10 cursor-grabbing shadow-soft",
      )}
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
    <div className="flex h-9 shrink-0 items-stretch border-b bg-muted/40 text-xs select-none" data-pg-titlebar="" data-tauri-drag-region="">
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
