import type { GraphPreview, NodeType } from "@promptgraph/shared";
import { cn } from "@/lib/utils";

/** A node card's size on the canvas (NodeCard is w-60), so the thumbnail keeps the graph's proportions. */
const NODE_W = 240;
const NODE_H = 80;
const PAD = 60;
/** Smallest area shown (graph units): a small graph is drawn at about the scale of a larger one, not blown up. */
const MIN_W = 1000;
const MIN_H = 600;

/** Fill and stroke per node type, matching the accents of the canvas cards (lib/node-meta). */
const TYPE_STYLE: Record<NodeType, string> = {
  prompt: "fill-orange-500/25 stroke-orange-500",
  command: "fill-amber-500/25 stroke-amber-500",
  shell: "fill-emerald-500/25 stroke-emerald-500",
  commit: "fill-sky-500/25 stroke-sky-500",
  pr: "fill-indigo-500/25 stroke-indigo-500",
  approval: "fill-violet-500/25 stroke-violet-500",
  merge: "fill-pink-500/25 stroke-pink-500",
  condition: "fill-teal-500/25 stroke-teal-500",
};

/**
 * A miniature of a graph (DESIGN §13.3): one rounded box per node, coloured by type, at its canvas position, and
 * the edges as curves from the bottom of the source to the top of the target (the default layout runs top to
 * bottom, §19.3). It scales to fit its box; strokes keep their width whatever the scale.
 */
export function GraphThumbnail({ preview, className }: { preview: GraphPreview; className?: string }) {
  if (preview.nodes.length === 0) {
    return <div className={cn("flex items-center justify-center text-xs text-muted-foreground", className)}>Empty graph</div>;
  }
  const xs = preview.nodes.map((n) => n.x);
  const ys = preview.nodes.map((n) => n.y);
  // The graph's bounds, padded and grown (around their centre) to the minimum area.
  const left = Math.min(...xs) - PAD;
  const top = Math.min(...ys) - PAD;
  const right = Math.max(...xs) + NODE_W + PAD;
  const bottom = Math.max(...ys) + NODE_H + PAD;
  const width = Math.max(right - left, MIN_W);
  const height = Math.max(bottom - top, MIN_H);
  const minX = (left + right - width) / 2;
  const minY = (top + bottom - height) / 2;
  const byId = new Map(preview.nodes.map((n) => [n.id, n]));
  return (
    <svg
      role="img"
      aria-label={`${preview.nodes.length} ${preview.nodes.length === 1 ? "step" : "steps"}`}
      viewBox={`${minX} ${minY} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
    >
      <g className="fill-none stroke-muted-foreground/50">
        {preview.edges.map((e, i) => {
          const s = byId.get(e.source);
          const t = byId.get(e.target);
          if (!s || !t) return null;
          const sx = s.x + NODE_W / 2;
          const sy = s.y + NODE_H;
          const tx = t.x + NODE_W / 2;
          const ty = t.y;
          const bend = Math.max(40, Math.abs(ty - sy) / 2);
          return <path key={i} d={`M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
        })}
      </g>
      {preview.nodes.map((n) => (
        <rect key={n.id} x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={18} className={TYPE_STYLE[n.type]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
