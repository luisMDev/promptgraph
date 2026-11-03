import { webRoutes } from "@promptgraph/shared";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useEditor, useRun, useView } from "../../store/view/context";
import { Icons } from "./icons";
import { Button, ButtonLink } from "./ui";

/** Contextual banners under the header: modified-outside warning (§14), disk conflicts, read-only states. */
export function Banners() {
  const view = useView();
  const modifiedOutside = useEditor((s) => s.modifiedOutside);
  const externalChange = useEditor((s) => s.externalChange);
  const activeRunId = useEditor((s) => s.activeRunId);
  const hasGraph = useEditor((s) => s.graph !== null);
  const selectedRunId = useRun((s) => s.selectedRunId);
  const run = useRun((s) => s.detail?.run);
  const runMode = selectedRunId !== null;
  const editor = view.editor.getState();

  return (
    <>
      {hasGraph && modifiedOutside && (
        <Banner tone="warning" onDismiss={() => editor.dismissModifiedOutside()}>
          This graph file was modified outside promptgraph since its last run. Review it — especially shell commands — before running.
        </Banner>
      )}
      {externalChange && (
        <Banner tone="warning">
          The graph file changed on disk while you have unsaved edits.
          <Button size="sm" className="ml-3" onClick={() => void editor.reloadFromDisk()}>
            Reload from disk
          </Button>
          <Button size="sm" variant="ghost" className="ml-1" onClick={() => editor.keepLocalChanges()}>
            Keep my edits
          </Button>
        </Banner>
      )}
      {!runMode && activeRunId && (
        <Banner tone="info">
          A run of this graph is active, so the graph is read-only.
          <ButtonLink size="sm" className="ml-3" to={webRoutes.run(view.repoId, activeRunId)}>
            View live run
          </ButtonLink>
        </Banner>
      )}
      {runMode && run && run.id !== activeRunId && (
        <Banner tone="info">
          Viewing run #{run.shortId} (read-only snapshot of the graph at run start).
          <ButtonLink size="sm" className="ml-3" to={webRoutes.graph(view.repoId, run.graphId)}>
            Back to editor
          </ButtonLink>
        </Banner>
      )}
    </>
  );
}

function Banner({ tone, children, onDismiss }: { tone: "warning" | "info"; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs",
        tone === "warning" ? "border-amber-500/30 bg-amber-500/10 text-amber-700" : "border-border bg-card text-foreground",
      )}
    >
      {tone === "warning" && <Icons.alert className="shrink-0" />}
      <div className="flex flex-1 items-center">{children}</div>
      {onDismiss && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="-my-1 text-current opacity-70 hover:bg-transparent dark:hover:bg-transparent hover:text-current hover:opacity-100" onClick={onDismiss}>
              <Icons.x />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
