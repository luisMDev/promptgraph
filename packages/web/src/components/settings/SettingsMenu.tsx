import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setTheme, type Theme, useTheme } from "../../lib/theme";
import { useDaemonStore } from "../../store/daemon-store";
import { toast } from "../../store/toast-store";
import { useRepoInfo, useView, useViewUi } from "../../store/view/context";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

/**
 * App settings menu (theme, desktop notifications toggle, repo/version info). A Radix dropdown menu whose open state
 * lives in the UI store (`settingsOpen`): keyboard navigation, focus return to the trigger, Escape and
 * outside-click dismissal come from Radix. The info text is static content, so it is not focusable.
 */
export function SettingsMenu() {
  const view = useView();
  const open = useViewUi((s) => s.settingsOpen);
  const settings = useDaemonStore((s) => s.settings);
  const daemon = useDaemonStore((s) => s.info);
  const repo = useRepoInfo();
  const notifyAvailable = daemon?.notificationsAvailable ?? true;
  const theme = useTheme();

  const toggleNotifications = (notifications: boolean) => {
    useDaemonStore
      .getState()
      .updateSettings({ notifications })
      .catch((err: unknown) => toast("error", `Could not save settings: ${String(err)}`));
  };

  return (
    <DropdownMenu open={open} onOpenChange={(o) => view.ui.getState().setSettingsOpen(o)}>
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
        <DropdownMenuLabel className="pt-0 pb-1 text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="dark" onSelect={(e) => e.preventDefault()}>
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light" onSelect={(e) => e.preventDefault()}>
            Light
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
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
        {repo && daemon && (
          <>
            <DropdownMenuSeparator />
            <div className="space-y-1 px-1.5 py-1 text-[11px] text-muted-foreground">
              <div className="truncate font-mono" title={repo.path}>
                {repo.path}
              </div>
              <div>
                promptgraph {daemon.version} · phase {daemon.phase}
              </div>
              {daemon.warnings.map((w) => (
                <div key={w} className="text-amber-600/90">
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
