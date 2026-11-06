import { useRoute } from "../lib/router/location";
import type { RepoRoute } from "../lib/router/routes";
import { useDaemonStore } from "../store/daemon-store";
import { HomeView } from "./HomeView";
import { NotFound, RepoRemoved } from "./NotFound";
import { RepoView } from "./RepoView";

/** The view of the current location (DESIGN §13.2): a tab's, or a test's memory location. */
export function RoutedView() {
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
