import { laneSwatch } from "../../lib/lanes";

/** Lane id pill in the lane's colour (same colour on node cards, the legend and the inspector). */
export function LaneBadge({ id, index, title }: { id: string; index: number; title?: string }) {
  return (
    <span title={title} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${laneSwatch(index).badge}`}>
      {id}
    </span>
  );
}
