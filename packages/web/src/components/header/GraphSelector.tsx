import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { webRoutes } from "@promptgraph/shared";
import { Link } from "../../lib/router/Link";
import { createGraph, deleteGraph } from "../../store/view/actions";
import { useEditor, useRepo, useView } from "../../store/view/context";
import { isReadOnly } from "../../store/view/editor-store";
import { ConfirmDialog, PromptDialog } from "../common/PromptDialog";
import { NewGraphDialog } from "../home/RepoDialogs";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

type Dialog = "create" | "rename" | "delete" | null;

/** Graph dropdown: links to the repository's graphs, create / rename / delete in its footer, and a link to the repository's overview (§13.3). */
export function GraphSelector() {
  const view = useView();
  const graphs = useRepo((s) => s.graphs) ?? [];
  const graph = useEditor((s) => s.graph);
  const loadError = useEditor((s) => s.loadError);
  const readOnly = useEditor(isReadOnly);
  const [dialog, setDialog] = useState<Dialog>(null);
  // A dialog picked from the menu opens only once the menu has closed and returned focus to the trigger: the
  // dialog then traps focus without racing the menu's focus restore, and gives focus back to the trigger.
  const pendingDialog = useRef<Dialog>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Modal has no Radix DialogTrigger to return focus to, so give it back to the menu trigger that opened it.
  const closeDialog = () => {
    setDialog(null);
    setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const openFromMenu = (d: Exclude<Dialog, null>) => {
    pendingDialog.current = d;
  };
  const currentId = useEditor((s) => s.graphId);

  return (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="ghost" className="max-w-72 gap-2 px-2.5 font-medium ring-1 ring-border ring-inset">
            <Icons.layers className="shrink-0 text-muted-foreground" />
            <span className="truncate">{graph?.name ?? (loadError ? "Invalid graph" : graphs.length ? "Select a graph" : "No graphs")}</span>
            <Icons.chevronDown className="shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-80 p-0"
          onCloseAutoFocus={(e) => {
            const next = pendingDialog.current;
            if (!next) return;
            pendingDialog.current = null;
            e.preventDefault();
            triggerRef.current?.focus();
            setDialog(next);
          }}
        >
          <div className="max-h-80 overflow-y-auto p-1">
            {graphs.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No graphs in this repository yet.</p>}
            <DropdownMenuRadioGroup value={currentId ?? ""}>
              {graphs.map((g) => (
                <DropdownMenuRadioItem key={g.id} value={g.id} className="gap-2 py-2 pr-8 pl-3" asChild>
                  <Link to={webRoutes.graph(view.repoId, g.id)}>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", g.loadError ? "text-red-700" : "text-foreground")}>{g.name ?? g.id}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {g.loadError ? g.loadError : g.issues?.length ? `${g.id}.json · ${g.issues.map((i) => i.identifier).join(", ")}` : `${g.id}.json`}
                      </span>
                    </span>
                    {g.loadError && <Icons.alert className="shrink-0 text-red-600" />}
                  </Link>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </div>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div className="flex gap-1 p-1">
            <DropdownMenuItem className="flex-1 justify-center text-xs font-medium" onSelect={() => openFromMenu("create")}>
              <Icons.plus /> New graph
            </DropdownMenuItem>
            {graph && (
              <DropdownMenuItem disabled={readOnly} className="flex-1 justify-center text-xs font-medium" onSelect={() => openFromMenu("rename")}>
                <Icons.pencil /> Rename
              </DropdownMenuItem>
            )}
            {(graph || loadError) && (
              <DropdownMenuItem
                variant="destructive"
                disabled={readOnly && !loadError}
                className="flex-1 justify-center text-xs font-medium"
                onSelect={() => openFromMenu("delete")}
              >
                <Icons.trash /> Delete
              </DropdownMenuItem>
            )}
          </div>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div className="p-1">
            <DropdownMenuItem className="justify-center text-xs font-medium" asChild>
              <Link to={webRoutes.repo(view.repoId)}>
                <Icons.layers /> All graphs
              </Link>
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "create" && (
        <NewGraphDialog repoId={view.repoId} takenIds={graphs.map((g) => g.id)} create={(v) => createGraph(view, v)} onClose={closeDialog} />
      )}
      {dialog === "rename" && graph && (
        <PromptDialog
          title="Rename graph"
          label="Name"
          initial={graph.name}
          submitLabel="Rename"
          hint={() => "The file name (id) stays the same."}
          onSubmit={(name) => view.editor.getState().rename(name)}
          onClose={closeDialog}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete graph"
          message={`Delete "${graph?.name ?? currentId ?? "this graph"}"? The graph file is removed from the repository; run history is kept.`}
          confirmLabel="Delete"
          onConfirm={() => {
            if (currentId) void deleteGraph(view, currentId);
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
