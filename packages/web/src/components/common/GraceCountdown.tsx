import type { NodeRun } from "@promptgraph/shared";
import { useNow } from "../../lib/use-now";
import { nodeControl } from "../../store/view/actions";
import { useView } from "../../store/view/context";
import { Button } from "./ui";

/** Whole seconds left of a running auto-completion countdown (§7.4), or null when none is showing. */
export function graceSecondsLeft(nodeRun: NodeRun | null | undefined, now: number): number | null {
  if (!nodeRun || nodeRun.status !== "running" || nodeRun.graceUntil === null) return null;
  const ms = nodeRun.graceUntil - now;
  return ms > 0 ? Math.ceil(ms / 1000) : null;
}

/**
 * "Auto-continuing in 5s… [Hold]" (§7.4, risk R3): Claude ended its turn and the node will succeed when
 * the grace period ends. Hold keeps the node open (it goes idle), e.g. when Claude asked a question.
 */
export function GraceCountdown({ nodeRun, compact = false }: { nodeRun: NodeRun | null | undefined; compact?: boolean }) {
  const view = useView();
  const active = !!nodeRun && nodeRun.status === "running" && nodeRun.graceUntil !== null;
  const now = useNow(active);
  const left = graceSecondsLeft(nodeRun, now);
  if (left === null || !nodeRun) return null;
  return (
    <div
      role="status"
      className={`flex items-center gap-2 rounded bg-sky-500/15 text-sky-700 ${compact ? "px-1.5 py-1 text-[11px]" : "px-2 py-1 text-xs"}`}
      title="Claude finished its turn. The step succeeds when the countdown ends; typing in the terminal or Hold keeps it open."
    >
      <span className="min-w-0 flex-1 truncate">
        Auto-continuing in <span className="font-mono tabular-nums">{left}s</span>…
      </span>
      <Button
        variant="primary"
        size="xs"
        className="nodrag nopan h-5 shrink-0 rounded px-1.5 text-[11px] font-semibold"
        onClick={(e) => {
          e.stopPropagation();
          void nodeControl(view, nodeRun.id, "hold");
        }}
      >
        Hold
      </Button>
    </div>
  );
}
