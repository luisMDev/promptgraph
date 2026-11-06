import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useToastStore } from "../../store/toast-store";
import { Icons } from "./icons";
import { Button } from "./ui";

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <Alert
          key={t.id}
          role="status"
          variant={t.kind === "error" ? "destructive" : "default"}
          className={cn("pointer-events-auto flex items-start gap-2 py-2.5 shadow-xl", t.kind === "error" && "border-destructive/40")}
        >
          {t.kind === "error" && <Icons.alert className="shrink-0" />}
          <AlertDescription className={cn("flex-1 text-sm", t.kind === "error" ? "text-destructive" : "text-foreground")}>
            {t.message}
          </AlertDescription>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss"
                className="-my-0.5 shrink-0 text-muted-foreground"
                onClick={() => useToastStore.getState().dismiss(t.id)}
              >
                <Icons.x />
              </Button>
            </TooltipTrigger>
            {/* Above the z-[60] toast stack, which would otherwise cover it. */}
            <TooltipContent className="z-[70]">Dismiss</TooltipContent>
          </Tooltip>
        </Alert>
      ))}
    </div>
  );
}
