import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "../../store/app-store";
import { useUiStore } from "../../store/ui-store";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

/**
 * App settings menu (desktop notifications toggle, repo/version info). A Radix dropdown menu whose open state
 * lives in the UI store (`settingsOpen`): keyboard navigation, focus return to the trigger, Escape and
 * outside-click dismissal come from Radix. The info text is static content, so it is not focusable.
 */
export function SettingsMenu() {
  const open = useUiStore((s) => s.settingsOpen);
  const settings = useAppStore((s) => s.settings);
  const repo = useAppStore((s) => s.repo);
  const notifyAvailable = repo?.notificationsAvailable ?? true;

  const toggleNotifications = (notifications: boolean) => {
    useAppStore
      .getState()
      .updateSettings({ notifications })
      .catch((err: unknown) => useUiStore.getState().toast("error", `Could not save settings: ${String(err)}`));
  };

  return (
    <DropdownMenu open={open} onOpenChange={(o) => useUiStore.getState().setSettingsOpen(o)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Settings" className="text-muted-foreground data-[state=open]:bg-accent">
              <Icons.settings />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72 p-2">
        <DropdownMenuLabel className="text-[11px] font-semibold tracking-wider uppercase">Settings</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={notifyAvailable && (settings?.notifications ?? true)}
          disabled={!settings || !notifyAvailable}
          onCheckedChange={(v) => toggleNotifications(v === true)}
          // Keep the menu open so the new state is visible.
          onSelect={(e) => e.preventDefault()}
        >
          {notifyAvailable ? "Desktop notifications" : "Desktop notifications (unavailable)"}
        </DropdownMenuCheckboxItem>
        <p className="px-1.5 py-1 text-[11px] leading-snug text-muted-foreground">
          {!notifyAvailable && "No notifier was found on this system (notify-send, or PowerShell on WSL). "}
          Notify when a node waits for input, approval, or finished a turn (notify-send on Linux, a toast on WSL).
        </p>
        {repo && (
          <>
            <DropdownMenuSeparator />
            <div className="space-y-1 px-1.5 py-1 text-[11px] text-muted-foreground">
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
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
