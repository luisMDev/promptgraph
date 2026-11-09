import type { RepoSummary } from "@promptgraph/shared";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorMessage, repoApi } from "../../api/rest";
import { useDaemonStore } from "../../store/daemon-store";
import { toast } from "../../store/toast-store";
import { discardEditorStore } from "../../store/view/editor-store";
import { Icons } from "../common/icons";
import { Logo } from "../common/Logo";
import { ConfirmDialog } from "../common/PromptDialog";
import { AddRepositoryDialog, AddRepositoryForm, NewGraphDialog, RemoveRepoDialog } from "../home/RepoDialogs";
import { useOverviewModel, type OverviewItem } from "./data";
import { OverviewLayout, type OverviewActions } from "./OverviewLayout";

type Dialog = { kind: "new" } | { kind: "add" } | { kind: "remove"; repo: RepoSummary } | { kind: "delete"; item: OverviewItem };

/**
 * Home and a repository's graphs in one screen (DESIGN §13.3): every graph of every registered repository, filtered by
 * repository (the route: `/` for all of them, `/r/<repoId>` for one), searchable and grouped by recency or repository.
 * New graph, Add repository, Remove repository and Delete graph are dialogs. With no repository it shows a welcome
 * with the Add repository form. It updates live from `repo:status` / `repo:removed`.
 */
export function Overview({ repoId }: { repoId: string | null }) {
  const m = useOverviewModel(repoId);
  const info = useDaemonStore((s) => s.info);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const actions: OverviewActions = {
    newGraph: () => setDialog({ kind: "new" }),
    addRepo: () => setDialog({ kind: "add" }),
    removeRepo: (repo) => setDialog({ kind: "remove", repo }),
    deleteGraph: (item) => setDialog({ kind: "delete", item }),
  };
  const deleteGraph = async ({ repo, graph }: OverviewItem) => {
    try {
      await repoApi(repo.id).deleteGraph(graph.id);
      discardEditorStore(repo.id, graph.id);
    } catch (err) {
      toast("error", `Could not delete graph: ${errorMessage(err)}`);
    }
    m.reload();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {info && info.warnings.length > 0 && (
        <Alert className="m-3 mb-0 w-auto rounded-sm border-0 bg-amber-500/10">
          <Icons.alert className="text-amber-700" />
          <AlertDescription className="space-y-0.5 text-xs text-amber-700!">
            {info.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      {m.reposError && (
        <p role="alert" className="px-6 pt-4 text-xs text-red-700">
          Could not list the repositories: {m.reposError}
        </p>
      )}
      {m.repos?.length === 0 ? <Welcome /> : <OverviewLayout m={m} actions={actions} />}
      {dialog?.kind === "new" && m.repos && <NewGraphDialog repos={m.repos} repoId={m.repoId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "add" && <AddRepositoryDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "remove" && <RemoveRepoDialog repo={dialog.repo} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete graph"
          message={`Delete "${dialog.item.graph.name ?? dialog.item.graph.id}" from ${dialog.item.repo.name}? The graph file is removed from the repository; run history is kept.`}
          confirmLabel="Delete"
          onConfirm={() => void deleteGraph(dialog.item)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** No repository yet: what promptgraph is and the Add repository form. */
function Welcome() {
  const info = useDaemonStore((s) => s.info);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-10">
      <div className="mx-auto my-auto w-full max-w-xl space-y-8">
        <div className="flex items-center gap-3">
          <Logo size={32} />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Welcome to promptgraph</h1>
            <p className="text-xs text-muted-foreground">Add a git repository to design and run its graphs{info ? ` · v${info.version}` : ""}.</p>
          </div>
        </div>
        <AddRepositoryForm />
        <p className="text-xs text-muted-foreground">
          Or run <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">promptgraph</code> inside a git repository.
        </p>
      </div>
    </div>
  );
}
