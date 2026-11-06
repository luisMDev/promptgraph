import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { parseRoute, type Route } from "./routes";

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing one. */
  replace?: boolean;
}

export interface OpenInNewTabOptions {
  /** Foreground tab (Ctrl/Cmd+Shift-click) rather than a background one. */
  activate: boolean;
}

/**
 * The location of a view (DESIGN §13.2): its tab's path (`components/tabs/TabViews`), or a memory location in
 * tests. Components read and change it only through this context, never through `window.location`; the
 * window URL follows the active tab (`lib/tabs/history`).
 */
export interface LocationValue {
  path: string;
  navigate(path: string, opts?: NavigateOptions): void;
  openInNewTab(path: string, opts: OpenInNewTabOptions): void;
}

export const LocationContext = createContext<LocationValue | null>(null);

/** In-memory location (tests). `onOpenInNewTab` records new-tab requests. */
export function MemoryLocationProvider({
  initialPath = "/",
  onOpenInNewTab,
  onNavigate,
  children,
}: {
  initialPath?: string;
  onOpenInNewTab?: (path: string, opts: OpenInNewTabOptions) => void;
  onNavigate?: (path: string, opts?: NavigateOptions) => void;
  children: ReactNode;
}) {
  const [path, setPath] = useState(initialPath);
  const navigate = useCallback(
    (to: string, opts?: NavigateOptions) => {
      onNavigate?.(to, opts);
      setPath(to);
    },
    [onNavigate],
  );
  const openInNewTab = useCallback((to: string, opts: OpenInNewTabOptions) => onOpenInNewTab?.(to, opts), [onOpenInNewTab]);
  const value = useMemo(() => ({ path, navigate, openInNewTab }), [path, navigate, openInNewTab]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useLocation(): LocationValue {
  const value = useContext(LocationContext);
  if (!value) throw new Error("useLocation must be used inside a location provider");
  return value;
}

export function useNavigate(): LocationValue["navigate"] {
  return useLocation().navigate;
}

export function useRoute(): Route {
  const { path } = useLocation();
  return useMemo(() => parseRoute(path), [path]);
}
