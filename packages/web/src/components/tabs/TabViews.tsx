import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LocationContext, type LocationValue, type NavigateOptions, type OpenInNewTabOptions } from "../../lib/router/location";
import { planMounted } from "../../lib/tabs/keep-alive";
import { tabsStore, useTabs, type Tab } from "../../store/tabs-store";
import type { EditorStoreApi } from "../../store/view/editor-store";
import { RoutedView } from "../../views/RoutedView";
import { TabContext, type TabContextValue } from "./tab-context";

type EditorRegistry = Map<string, EditorStoreApi | null>;

/**
 * The views of the tabs (DESIGN §13.4 Keep-alive): only the active tab mounts at load, the others on their
 * first activation; inactive views stay mounted but `hidden` + `inert`. Beyond MAX_MOUNTED the least
 * recently used view is unmounted (it remounts from its path), except a view whose editor is dirty or saving.
 */
export function TabViews({ children = <RoutedView /> }: { children?: ReactNode }) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const mru = useTabs((s) => s.mru);
  const editors = useRef<EditorRegistry>(new Map()).current;
  const [mounted, setMounted] = useState<readonly string[]>(() => [activeId]);

  const pinned = (tabId: string) => {
    const editor = editors.get(tabId)?.getState();
    return !!editor && (editor.dirty || editor.saving);
  };
  const plan = planMounted(mounted, { tabIds: tabs.map((t) => t.id), activeId, mru, pinned });
  // Adjusting state while rendering: React re-renders before committing.
  if (plan !== mounted) setMounted(plan);

  return (
    <>
      {plan.map((id) => {
        const tab = tabs.find((t) => t.id === id);
        return tab ? (
          <TabView key={id} tab={tab} active={id === activeId} editors={editors}>
            {children}
          </TabView>
        ) : null;
      })}
    </>
  );
}

function TabView({ tab, active, editors, children }: { tab: Tab; active: boolean; editors: EditorRegistry; children: ReactNode }) {
  const store = tabsStore();
  const { id, path } = tab;
  const navigate = useCallback((to: string, opts?: NavigateOptions) => store.getState().navigate(id, to, opts), [store, id]);
  const openInNewTab = useCallback((to: string, opts: OpenInNewTabOptions) => void store.getState().open(to, { activate: opts.activate }), [store]);
  const location: LocationValue = useMemo(() => ({ path, navigate, openInNewTab }), [path, navigate, openInNewTab]);
  const context: TabContextValue = useMemo(
    () => ({
      tabId: id,
      active,
      setTitle: (title) => store.getState().setTitle(id, title),
      close: () => store.getState().close(id),
      reportEditor: (editor) => void editors.set(id, editor),
    }),
    [id, active, store, editors],
  );
  useEffect(() => () => void editors.delete(id), [editors, id]);

  return (
    <div data-tab-view={id} hidden={!active} inert={!active} className={active ? "flex min-h-0 flex-1 flex-col" : undefined}>
      <LocationContext.Provider value={location}>
        <TabContext.Provider value={context}>{children}</TabContext.Provider>
      </LocationContext.Provider>
    </div>
  );
}
