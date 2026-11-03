import { useEffect, type ReactNode } from "react";
import { SessionBanners, SignedOut } from "./components/common/SessionBanners";
import { Toasts } from "./components/common/Toasts";
import { TabStrip } from "./components/tabs/TabStrip";
import { TabViews } from "./components/tabs/TabViews";
import { isDesktopWindow } from "./lib/desktop";
import { installKeymap } from "./lib/keymap";
import { syncTabHistory } from "./lib/tabs/history";
import { useDaemonStore } from "./store/daemon-store";
import { startLiveUpdates } from "./store/live";
import { runTabAction, tabsStore } from "./store/tabs-store";
import { FullScreenMessage } from "./views/NotFound";

/**
 * The page: the tab strip and the views of this window's tabs (DESIGN §13.4). The window URL follows the
 * active tab (§13.2) and the tab shortcuts are installed on the window.
 */
export function App() {
  useEffect(() => {
    const store = tabsStore();
    const stopHistory = syncTabHistory(store, window);
    const stopKeys = installKeymap(window, { desktop: isDesktopWindow, onAction: (action) => runTabAction(store, action) });
    return () => {
      stopHistory();
      stopKeys();
    };
  }, []);
  return (
    <AppShell strip={<TabStrip />}>
      <TabViews />
    </AppShell>
  );
}

/**
 * Boots the daemon-wide state and the socket, then renders `children` (the views) below the strip and the
 * session/connection/version banners (§13.5).
 */
export function AppShell({ strip, children }: { strip?: ReactNode; children: ReactNode }) {
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
      {strip}
      <SessionBanners />
      {hasInfo ? (
        children
      ) : infoError ? (
        <FullScreenMessage title="Cannot reach promptgraph" detail={infoError} retry={() => void useDaemonStore.getState().loadInfo()} />
      ) : (
        <FullScreenMessage title="Loading…" />
      )}
      <Toasts />
    </div>
  );
}
