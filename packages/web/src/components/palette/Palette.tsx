import type { NodeType } from "@promptgraph/shared";
import { NODE_TYPE_META, PALETTE_ORDER } from "../../lib/node-meta";
import { useEditor, useView } from "../../store/view/context";
import { isReadOnly } from "../../store/view/editor-store";
import { PALETTE_MIME } from "../canvas/Canvas";
import { Badge } from "@/components/ui/badge";
import { NodeTypeIcon } from "../common/icons";
import { Button } from "../common/ui";

/** Node types to drag onto the canvas (click adds one below the last node). */
export function Palette() {
  const view = useView();
  const readOnly = useEditor(isReadOnly);
  const phase = useEditor((s) => s.phase);
  const supported = useEditor((s) => s.supportedNodeTypes);
  const hint = useEditor((s) =>
    !s.graph
      ? s.loadError
        ? "This graph could not be loaded."
        : "Create or select a graph to add nodes."
      : s.activeRunId
        ? "The graph is read-only while a run is active."
        : "Drag onto the canvas, or click to append.",
  );

  const addByClick = (type: NodeType) => {
    const g = view.editor.getState().graph;
    if (!g) return;
    const last = g.nodes.reduce((m, n) => (n.position.x > m.x ? n.position : m), { x: -320, y: 96 });
    const id = view.editor.getState().addNode(type, { x: last.x + 320, y: last.y });
    if (id) view.ui.getState().revealNode(id);
  };

  return (
    <div className="space-y-1 p-2">
      <p className="px-2 pt-1 pb-2 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      {PALETTE_ORDER.map((type) => {
        const meta = NODE_TYPE_META[type];
        const needsPhase2 = meta.phase2 && phase < 2;
        const notYet = !needsPhase2 && supported !== null && !supported.includes(type);
        const unsupported = needsPhase2 || notYet;
        return (
          <Button
            key={type}
            variant="ghost"
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
            // Disabled entries keep their title tooltip and not-allowed cursor (shadcn disables pointer events);
            // icons keep their 1em size.
            className="group h-auto w-full cursor-grab justify-start gap-2.5 rounded-md px-2 py-1.5 text-left font-normal whitespace-normal hover:border-border active:cursor-grabbing disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40 [&_svg:not([class*='size-'])]:size-[1em]"
          >
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-sm ${meta.accent}`}>
              <NodeTypeIcon type={type} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/90">
                {meta.title}
                {unsupported && (
                  <Badge variant="secondary" className="h-auto rounded px-1 py-px text-[9px] font-normal tracking-wide text-muted-foreground uppercase">
                    {needsPhase2 ? "phase 2" : "coming soon"}
                  </Badge>
                )}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">{meta.description}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
