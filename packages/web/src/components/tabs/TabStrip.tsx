import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HOME_PATH, activeTab, tabsStore, useTabs, type Tab } from "../../store/tabs-store";
import { Icons } from "../common/icons";
import { useLoadTabRepos, useTabAttention, useTabTitle } from "./use-tab-title";

/**
 * The in-app tab strip at the top of the page (DESIGN §13.4): title, attention dot and close button per
 * tab, middle-click closes, "+" opens Home in a new tab. It scrolls horizontally when the tabs overflow and
 * keeps the active one in view. `role=tablist` with roving focus (arrows, Home/End). In the desktop window
 * the spacer is the drag region and `windowControls` the window buttons (§20).
 */
export function TabStrip({ windowControls }: { windowControls?: ReactNode }) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const listRef = useRef<HTMLDivElement>(null);
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
    <div className="flex h-9 shrink-0 items-stretch border-b bg-muted/40 text-xs select-none">
      <div ref={listRef} role="tablist" aria-label="Tabs" className="pg-tab-list flex min-w-0 items-stretch overflow-x-auto" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} active={tab.id === activeId} />
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
      <div className="min-w-6 flex-1" data-pg-tabstrip-spacer="" />
      {windowControls}
      <DocumentTitle />
    </div>
  );
}

function TabItem({ tab, active }: { tab: Tab; active: boolean }) {
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
      title={title}
      className={cn(
        "group relative flex w-44 min-w-24 shrink items-center gap-1.5 border-r pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-background text-foreground" : "cursor-pointer text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
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

/** The window title follows the active tab. */
function DocumentTitle() {
  const tab = useTabs(activeTab);
  const title = useTabTitle(tab);
  useEffect(() => {
    document.title = title === "Home" ? "promptgraph" : `${title} · promptgraph`;
  }, [title]);
  return null;
}
