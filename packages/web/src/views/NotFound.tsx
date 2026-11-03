import { webRoutes } from "@promptgraph/shared";
import { useState, type ReactNode } from "react";
import { Button } from "../components/common/ui";
import { errorMessage } from "../api/rest";
import { Link } from "../lib/router/Link";
import { useLocation } from "../lib/router/location";
import { useDaemonStore, type RemovedRepo } from "../store/daemon-store";

export function FullScreenMessage({ title, detail, retry, children }: { title: string; detail?: ReactNode; retry?: () => void; children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && <p className="max-w-lg text-xs text-muted-foreground">{detail}</p>}
      {children}
      {retry && (
        <Button size="sm" className="mt-1" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

const homeLink = "text-xs font-medium text-blue-600 hover:underline";

/** Unknown repository, graph, run or step (DESIGN §13.2): never a silent redirect. */
export function NotFound({ what = "There is nothing at this address.", repoId }: { what?: string; repoId?: string }) {
  return (
    <FullScreenMessage title="Not found" detail={what}>
      <div className="flex gap-4">
        {repoId && (
          <Link to={webRoutes.repo(repoId)} className={homeLink}>
            Open the repository
          </Link>
        )}
        <Link to={webRoutes.home()} className={homeLink}>
          Go to Home
        </Link>
      </div>
    </FullScreenMessage>
  );
}

/**
 * A view of a repository that was removed (DESIGN §13.4): "Add again" registers the remembered path (same id,
 * so the view reloads), "Close" goes Home.
 */
export function RepoRemoved({ repo }: { repo: RemovedRepo }) {
  const { navigate } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      await useDaemonStore.getState().addRepo(repo.path);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FullScreenMessage title="Repository removed" detail={`${repo.name} (${repo.path}) is no longer registered with promptgraph.`}>
      {error && (
        <p role="alert" className="max-w-lg text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="mt-1 flex gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void addAgain()}>
          Add again
        </Button>
        <Button size="sm" onClick={() => navigate(webRoutes.home())}>
          Close
        </Button>
      </div>
    </FullScreenMessage>
  );
}
