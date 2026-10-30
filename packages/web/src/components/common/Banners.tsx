import type { ReactNode } from "react";
import { useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { Icons } from "./icons";
import { Button } from "./ui";

/** Contextual banners under the header: modified-outside warning (§14), disk conflicts, read-only states. */
export function Banners() {
  const modifiedOutside = useEditorStore((s) => s.modifiedOutside);
  const externalChange = useEditorStore((s) => s.externalChange);
  const activeRunId = useEditorStore((s) => s.activeRunId);
  const hasGraph = useEditorStore((s) => s.graph !== null);
  const selectedRunId = useRunStore((s) => s.selectedRunId);
  const run = useRunStore((s) => s.detail?.run);
  const runMode = selectedRunId !== null;

  return (
    <>
      {hasGraph && modifiedOutside && (
        <Banner tone="warning" onDismiss={() => useEditorStore.getState().dismissModifiedOutside()}>
          This graph file was modified outside promptgraph since its last run. Review it — especially shell commands — before running.
        </Banner>
      )}
      {externalChange && (
        <Banner tone="warning">
          The graph file changed on disk while you have unsaved edits.
          <Button size="sm" className="ml-3" onClick={() => void useEditorStore.getState().reloadFromDisk()}>
            Reload from disk
          </Button>
          <Button size="sm" variant="ghost" className="ml-1" onClick={() => useEditorStore.getState().keepLocalChanges()}>
            Keep my edits
          </Button>
        </Banner>
      )}
      {!runMode && activeRunId && (
        <Banner tone="info">
          A run of this graph is active, so the graph is read-only.
          <Button size="sm" className="ml-3" onClick={() => void useRunStore.getState().selectRun(activeRunId)}>
            View live run
          </Button>
        </Banner>
      )}
      {runMode && run && run.id !== activeRunId && (
        <Banner tone="info">
          Viewing run #{run.shortId} (read-only snapshot of the graph at run start).
          <Button size="sm" className="ml-3" onClick={() => void useRunStore.getState().selectRun(null)}>
            Back to editor
          </Button>
        </Banner>
      )}
    </>
  );
}

function Banner({ tone, children, onDismiss }: { tone: "warning" | "info"; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs ${tone === "warning" ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-blue-500/20 bg-blue-500/5 text-blue-200"}`}
    >
      {tone === "warning" && <Icons.alert className="shrink-0" />}
      <div className="flex flex-1 items-center">{children}</div>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" className="opacity-70 hover:opacity-100" onClick={onDismiss}>
          <Icons.x />
        </button>
      )}
    </div>
  );
}
