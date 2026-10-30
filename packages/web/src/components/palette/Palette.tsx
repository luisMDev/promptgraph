import type { NodeType } from "@promptgraph/shared";
import { NODE_TYPE_META, PALETTE_ORDER } from "../../lib/node-meta";
import { isReadOnly, useEditorStore } from "../../store/editor-store";
import { useUiStore } from "../../store/ui-store";
import { PALETTE_MIME } from "../canvas/Canvas";
import { NodeTypeIcon } from "../common/icons";

/** Node types to drag onto the canvas (click adds one below the last node). */
export function Palette() {
  const readOnly = useEditorStore(isReadOnly);
  const phase = useEditorStore((s) => s.phase);
  const supported = useEditorStore((s) => s.supportedNodeTypes);
  const hint = useEditorStore((s) =>
    !s.graph
      ? s.loadError
        ? "This graph could not be loaded."
        : "Create or select a graph to add nodes."
      : s.activeRunId
        ? "The graph is read-only while a run is active."
        : "Drag onto the canvas, or click to append.",
  );

  const addByClick = (type: NodeType) => {
    const g = useEditorStore.getState().graph;
    if (!g) return;
    const last = g.nodes.reduce((m, n) => (n.position.x > m.x ? n.position : m), { x: -320, y: 96 });
    const id = useEditorStore.getState().addNode(type, { x: last.x + 320, y: last.y });
    if (id) useUiStore.getState().revealNode(id);
  };

  return (
    <div className="space-y-1 p-2">
      <p className="px-2 pt-1 pb-2 text-[11px] leading-snug text-zinc-500">{hint}</p>
      {PALETTE_ORDER.map((type) => {
        const meta = NODE_TYPE_META[type];
        const needsPhase2 = meta.phase2 && phase < 2;
        const notYet = !needsPhase2 && supported !== null && !supported.includes(type);
        const unsupported = needsPhase2 || notYet;
        return (
          <button
            key={type}
            type="button"
            draggable={!readOnly}
            disabled={readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_MIME, type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => addByClick(type)}
            title={
              needsPhase2
                ? `${meta.description} (needs Phase 2: the current engine will reject it)`
                : notYet
                  ? `${meta.description} (not available in this version yet: graphs with it cannot run)`
                  : meta.description
            }
            className="group flex w-full cursor-grab items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-zinc-700 hover:bg-zinc-800/70 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-sm ${meta.accent}`}>
              <NodeTypeIcon type={type} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-200">
                {meta.title}
                {unsupported && (
                  <span className="rounded bg-zinc-800 px-1 py-px text-[9px] font-normal tracking-wide text-zinc-400 uppercase">
                    {needsPhase2 ? "phase 2" : "coming soon"}
                  </span>
                )}
              </span>
              <span className="block truncate text-[11px] text-zinc-500">{meta.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
