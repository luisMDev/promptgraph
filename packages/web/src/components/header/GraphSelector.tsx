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
import { createGraph, deleteGraph, selectGraph, uniqueGraphId } from "../../store/app-actions";
import { useAppStore } from "../../store/app-store";
import { isReadOnly, useEditorStore } from "../../store/editor-store";
import { ConfirmDialog, PromptDialog } from "../common/PromptDialog";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

type Dialog = "create" | "rename" | "delete" | null;

/** Graph dropdown: switch graphs, plus create / rename / delete in its footer. */
export function GraphSelector() {
  const graphs = useAppStore((s) => s.graphs);
  const graph = useEditorStore((s) => s.graph);
  const loadError = useEditorStore((s) => s.loadError);
  const readOnly = useEditorStore(isReadOnly);
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
  const currentId = useEditorStore((s) => s.graphId);

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
            <DropdownMenuRadioGroup
              value={currentId ?? ""}
              onValueChange={(id) => {
                if (id !== currentId) void selectGraph(id);
              }}
            >
              {graphs.map((g) => (
                <DropdownMenuRadioItem key={g.id} value={g.id} className="gap-2 py-2 pr-8 pl-3">
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", g.loadError ? "text-red-700" : "text-foreground")}>{g.name ?? g.id}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{g.loadError ? g.loadError : `${g.id}.json`}</span>
                  </span>
                  {g.loadError && <Icons.alert className="shrink-0 text-red-600" />}
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
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "create" && (
        <PromptDialog
          title="New graph"
          label="Name"
          submitLabel="Create"
          hint={(v) => (v.trim() ? `Saved as .promptgraph/graphs/${uniqueGraphId(v, graphs.map((g) => g.id))}.json` : null)}
          onSubmit={(name) => void createGraph(name)}
          onClose={closeDialog}
        />
      )}
      {dialog === "rename" && graph && (
        <PromptDialog
          title="Rename graph"
          label="Name"
          initial={graph.name}
          submitLabel="Rename"
          hint={() => "The file name (id) stays the same."}
          onSubmit={(name) => useEditorStore.getState().rename(name)}
          onClose={closeDialog}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete graph"
          message={`Delete "${graph?.name ?? currentId ?? "this graph"}"? The graph file is removed from the repository; run history is kept.`}
          confirmLabel="Delete"
          onConfirm={() => {
            if (currentId) void deleteGraph(currentId);
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
