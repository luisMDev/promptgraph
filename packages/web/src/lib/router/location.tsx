import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
 * The location of a view (DESIGN §13.2): the window's location before in-app tabs exist, a tab's location
 * after. Components read and change it only through this context, never through `window.location`.
 */
export interface LocationValue {
  path: string;
  navigate(path: string, opts?: NavigateOptions): void;
  openInNewTab(path: string, opts: OpenInNewTabOptions): void;
}

export const LocationContext = createContext<LocationValue | null>(null);

function windowPath(): string {
  const { pathname, search, hash } = window.location;
  return pathname + search + hash;
}

/** The window's history as the location (popstate re-applies it). */
export function WindowLocationProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(windowPath);
  useEffect(() => {
    const onPop = () => setPath(windowPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, opts?: NavigateOptions) => {
    if (opts?.replace) window.history.replaceState(null, "", to);
    else if (to !== windowPath()) window.history.pushState(null, "", to);
    setPath(windowPath());
  }, []);
  const openInNewTab = useCallback((to: string) => {
    // A browser decides itself whether the new tab is in the foreground.
    window.open(to, "_blank", "noopener");
  }, []);
  const value = useMemo(() => ({ path, navigate, openInNewTab }), [path, navigate, openInNewTab]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

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
