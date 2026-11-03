import { useEffect } from "react";
import { SessionBanners, SignedOut } from "./components/common/SessionBanners";
import { Toasts } from "./components/common/Toasts";
import { WindowLocationProvider, useRoute } from "./lib/router/location";
import type { RepoRoute } from "./lib/router/routes";
import { useDaemonStore } from "./store/daemon-store";
import { startLiveUpdates } from "./store/live";
import { HomeView } from "./views/HomeView";
import { FullScreenMessage, NotFound, RepoRemoved } from "./views/NotFound";
import { RepoView } from "./views/RepoView";

/** The page: the window's location, routed to one view (DESIGN §13.2). */
export function App() {
  return (
    <WindowLocationProvider>
      <AppShell />
    </WindowLocationProvider>
  );
}

/**
 * Boots the daemon-wide state and the socket, then renders the view of the current location with the
 * session/connection/version banners above it (§13.5). Rendered inside a location provider.
 */
export function AppShell() {
  const signedOut = useDaemonStore((s) => s.signedOut);
  const hasInfo = useDaemonStore((s) => s.info !== null);
  const infoError = useDaemonStore((s) => s.infoError);

  useEffect(() => {
    const stop = startLiveUpdates();
    const daemon = useDaemonStore.getState();
    void daemon.loadInfo();
    void daemon.loadRepos();
    void daemon.loadSettings();
    return stop;
  }, []);

  if (signedOut) return <SignedOut />;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <SessionBanners />
      {hasInfo ? (
        <RoutedView />
      ) : infoError ? (
        <FullScreenMessage title="Cannot reach promptgraph" detail={infoError} retry={() => void useDaemonStore.getState().loadInfo()} />
      ) : (
        <FullScreenMessage title="Loading…" />
      )}
      <Toasts />
    </div>
  );
}

function RoutedView() {
  const route = useRoute();
  if (route.kind === "home") return <HomeView />;
  if (route.kind === "notFound") return <NotFound />;
  return <RepoRoot key={route.repoId} route={route} />;
}

/** A removed repository shows "Repository removed" until it is added again, then a fresh view. */
function RepoRoot({ route }: { route: RepoRoute }) {
  const removed = useDaemonStore((s) => s.removed[route.repoId]);
  if (removed) return <RepoRemoved repo={removed} />;
  return <RepoView route={route} />;
}
