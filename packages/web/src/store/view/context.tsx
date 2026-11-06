import type { RepoInfoResponse } from "@promptgraph/shared";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import type { RepoApi } from "../../api/rest";
import { useLocation, type LocationValue } from "../../lib/router/location";
import { useRepoCache, type RepoCacheState } from "../repo-cache";
import type { EditorStore, EditorStoreApi } from "./editor-store";
import type { RunStore, RunStoreApi } from "./run-store";
import type { UiStore, ViewUiStoreApi } from "./ui-store";

/**
 * The stores of one mounted view (DESIGN §13.4): run and UI stores are its own; the editor store is shared
 * with every other view of the same `(repoId, graphId)`; repository data comes from the repo cache.
 */
export interface ViewStores {
  repoId: string;
  api: RepoApi;
  /** Editor of the graph the view shows (an empty store while it shows none). */
  editor: EditorStoreApi;
  run: RunStoreApi;
  ui: ViewUiStoreApi;
  /** The view is the visible one (always true until in-app tabs). */
  active: boolean;
}

/** A view's stores plus its location: what the actions in `store/view/actions.ts` work on. */
export interface View extends ViewStores {
  navigate: LocationValue["navigate"];
  openInNewTab: LocationValue["openInNewTab"];
}

const ViewContext = createContext<ViewStores | null>(null);

export function ViewProvider({ value, children }: { value: ViewStores; children: ReactNode }) {
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

function useViewStores(): ViewStores {
  const stores = useContext(ViewContext);
  if (!stores) throw new Error("view hooks must be used inside a ViewProvider");
  return stores;
}

export function useView(): View {
  const stores = useViewStores();
  const { navigate, openInNewTab } = useLocation();
  return useMemo(() => ({ ...stores, navigate, openInNewTab }), [stores, navigate, openInNewTab]);
}

export function useEditor<T>(selector: (s: EditorStore) => T): T {
  return useStore(useViewStores().editor, selector);
}

export function useRun<T>(selector: (s: RunStore) => T): T {
  return useStore(useViewStores().run, selector);
}

export function useViewUi<T>(selector: (s: UiStore) => T): T {
  return useStore(useViewStores().ui, selector);
}

/** Whether the view is visible: hidden views open no terminals and send no resizes (DESIGN §13.4). */
export function useTabActive(): boolean {
  return useViewStores().active;
}

/** Data of the view's repository (shared cache). */
export function useRepo<T>(selector: (s: RepoCacheState) => T): T {
  return useRepoCache(useViewStores().repoId, selector);
}

export function useRepoInfo(): RepoInfoResponse | null {
  return useRepo((s) => s.info);
}
