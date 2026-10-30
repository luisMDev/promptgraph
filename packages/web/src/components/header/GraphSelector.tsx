import { useRef, useState, type ReactNode } from "react";
import { createGraph, deleteGraph, selectGraph, uniqueGraphId } from "../../store/app-actions";
import { useAppStore } from "../../store/app-store";
import { isReadOnly, useEditorStore } from "../../store/editor-store";
import { ConfirmDialog, PromptDialog } from "../common/PromptDialog";
import { Icons } from "../common/icons";
import { useDismiss } from "../common/ui";

type Dialog = "create" | "rename" | "delete" | null;

/** Graph dropdown with create / rename / delete. */
export function GraphSelector() {
  const graphs = useAppStore((s) => s.graphs);
  const graph = useEditorStore((s) => s.graph);
  const loadError = useEditorStore((s) => s.loadError);
  const readOnly = useEditorStore(isReadOnly);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const currentId = useEditorStore((s) => s.graphId);

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-8 max-w-72 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-zinc-100 ring-1 ring-zinc-800 ring-inset hover:bg-zinc-800"
      >
        <Icons.layers className="shrink-0 text-zinc-400" />
        <span className="truncate">{graph?.name ?? (loadError ? "Invalid graph" : graphs.length ? "Select a graph" : "No graphs")}</span>
        <Icons.chevronDown className="shrink-0 text-zinc-500" />
      </button>
      {graph && (
        <button
          type="button"
          title="Rename graph"
          disabled={readOnly}
          onClick={() => setDialog("rename")}
          className="flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        >
          <Icons.pencil />
        </button>
      )}
      {open && (
        <div className="absolute top-10 left-0 z-40 w-80 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
          <div className="max-h-80 overflow-y-auto p-1">
            {graphs.length === 0 && <p className="px-3 py-2 text-xs text-zinc-500">No graphs in this repository yet.</p>}
            {graphs.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (g.id !== currentId) void selectGraph(g.id);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-zinc-800 ${g.id === currentId ? "bg-zinc-800/70" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${g.loadError ? "text-red-300" : "text-zinc-100"}`}>{g.name ?? g.id}</span>
                  <span className="block truncate font-mono text-[11px] text-zinc-500">{g.loadError ? g.loadError : `${g.id}.json`}</span>
                </span>
                {g.loadError && <Icons.alert className="shrink-0 text-red-400" />}
              </button>
            ))}
          </div>
          <div className="flex gap-1 border-t border-zinc-800 p-1">
            <MenuAction
              onClick={() => {
                setOpen(false);
                setDialog("create");
              }}
            >
              <Icons.plus /> New graph
            </MenuAction>
            {(graph || loadError) && (
              <MenuAction
                danger
                disabled={readOnly && !loadError}
                onClick={() => {
                  setOpen(false);
                  setDialog("delete");
                }}
              >
                <Icons.trash /> Delete
              </MenuAction>
            )}
          </div>
        </div>
      )}
      {dialog === "create" && (
        <PromptDialog
          title="New graph"
          label="Name"
          submitLabel="Create"
          hint={(v) => (v.trim() ? `Saved as .promptgraph/graphs/${uniqueGraphId(v, graphs.map((g) => g.id))}.json` : null)}
          onSubmit={(name) => void createGraph(name)}
          onClose={() => setDialog(null)}
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
          onClose={() => setDialog(null)}
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
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function MenuAction({ children, onClick, danger, disabled }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium disabled:opacity-40 ${danger ? "text-red-300 hover:bg-red-500/10" : "text-zinc-300 hover:bg-zinc-800"}`}
    >
      {children}
    </button>
  );
}
