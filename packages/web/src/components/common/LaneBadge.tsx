import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { laneSwatch } from "../../lib/lanes";

/** Lane id pill in the lane's colour (same colour on node cards, the legend and the inspector). */
export function LaneBadge({ id, index, title }: { id: string; index: number; title?: string }) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn("h-auto rounded border-transparent px-1.5 py-0.5 font-mono text-[10px] font-normal ring-1", laneSwatch(index).badge)}
    >
      {id}
    </Badge>
  );
}
