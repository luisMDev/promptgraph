import { useUiStore } from "../../store/ui-store";
import { Icons } from "./icons";

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl ${t.kind === "error" ? "border-red-500/40 bg-red-950/90 text-red-100" : "border-zinc-700 bg-zinc-900/95 text-zinc-100"}`}
        >
          {t.kind === "error" && <Icons.alert className="mt-0.5 shrink-0 text-red-400" />}
          <span className="flex-1">{t.message}</span>
          <button type="button" aria-label="Dismiss" className="text-zinc-400 hover:text-zinc-100" onClick={() => useUiStore.getState().dismissToast(t.id)}>
            <Icons.x />
          </button>
        </div>
      ))}
    </div>
  );
}
