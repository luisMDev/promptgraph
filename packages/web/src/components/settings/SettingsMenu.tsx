import { useRef } from "react";
import { useAppStore } from "../../store/app-store";
import { useUiStore } from "../../store/ui-store";
import { Icons } from "../common/icons";
import { Checkbox, useDismiss } from "../common/ui";

/** App settings popover (desktop notifications toggle, repo/version info). */
export function SettingsMenu() {
  const open = useUiStore((s) => s.settingsOpen);
  const settings = useAppStore((s) => s.settings);
  const repo = useAppStore((s) => s.repo);
  const notifyAvailable = repo?.notificationsAvailable ?? true;
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => useUiStore.getState().setSettingsOpen(false));

  const toggleNotifications = (notifications: boolean) => {
    useAppStore
      .getState()
      .updateSettings({ notifications })
      .catch((err: unknown) => useUiStore.getState().toast("error", `Could not save settings: ${String(err)}`));
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Settings"
        onClick={() => useUiStore.getState().setSettingsOpen(!open)}
        className={`flex size-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${open ? "bg-zinc-800 text-zinc-100" : ""}`}
      >
        <Icons.settings />
      </button>
      {open && (
        <div className="absolute top-10 right-0 z-40 w-72 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-xl">
          <h3 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Settings</h3>
          <Checkbox
            checked={notifyAvailable && (settings?.notifications ?? true)}
            disabled={!settings || !notifyAvailable}
            onChange={toggleNotifications}
            label={notifyAvailable ? "Desktop notifications" : "Desktop notifications (unavailable)"}
          />
          <p className="text-[11px] leading-snug text-zinc-500">
            {!notifyAvailable && "No notifier was found on this system (notify-send, or PowerShell on WSL). "}
            Notify when a node waits for input, approval, or finished a turn (notify-send on Linux, a toast on WSL).
          </p>
          {repo && (
            <div className="space-y-1 border-t border-zinc-800 pt-3 text-[11px] text-zinc-500">
              <div className="truncate font-mono" title={repo.path}>
                {repo.path}
              </div>
              <div>
                promptgraph {repo.version} · phase {repo.phase}
              </div>
              {repo.warnings.map((w) => (
                <div key={w} className="text-amber-400/90">
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
