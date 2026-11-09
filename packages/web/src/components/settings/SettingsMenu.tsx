import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppSettings } from "@promptgraph/shared";
import { MicIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { setTheme, type Theme, useTheme } from "../../lib/theme";
import { useDaemonStore } from "../../store/daemon-store";
import { toast } from "../../store/toast-store";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";
import { OPEN_VOICE_SETTINGS_EVENT } from "../chat/Dictation";
import { LinearSettingsDialog } from "./LinearSettingsDialog";
import { VoiceSettingsDialog } from "./VoiceSettingsDialog";

/** Whether the settings menu is open: one menu per window, in the tab strip (DESIGN §13.4). */
export const useSettingsMenu = create<{ open: boolean; setOpen(open: boolean): void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/**
 * App settings menu (theme, desktop notifications toggle, voice dictation and Linear dialogs, repo/version info), at the end of the
 * tab strip. A Radix dropdown menu whose open state lives in `useSettingsMenu`: keyboard navigation, focus return to the
 * trigger, Escape and outside-click dismissal come from Radix. The info text is static content, so it is not
 * focusable. `repoPath`: the repository of the active tab, shown with the version (none on Home).
 */
export function SettingsMenu({ repoPath = null }: { repoPath?: string | null }) {
  const open = useSettingsMenu((s) => s.open);
  const settings = useDaemonStore((s) => s.settings);
  const daemon = useDaemonStore((s) => s.info);
  const notifyAvailable = daemon?.notificationsAvailable ?? true;
  const theme = useTheme();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [linearOpen, setLinearOpen] = useState(false);

  // The composer's "voice unavailable" popover opens the voice settings too.
  useEffect(() => {
    const open = () => setVoiceOpen(true);
    window.addEventListener(OPEN_VOICE_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_VOICE_SETTINGS_EVENT, open);
  }, []);

  const save = (patch: Partial<AppSettings>) => {
    useDaemonStore
      .getState()
      .updateSettings(patch)
      .catch((err: unknown) => toast("error", `Could not save settings: ${String(err)}`));
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={(o) => useSettingsMenu.getState().setOpen(o)}>
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
            onCheckedChange={(v) => save({ notifications: v === true })}
            // Keep the menu open so the new state is visible.
            onSelect={(e) => e.preventDefault()}
          >
            {notifyAvailable ? "Desktop notifications" : "Desktop notifications (unavailable)"}
          </DropdownMenuCheckboxItem>
          <p className="px-1.5 py-1 text-[11px] leading-snug text-muted-foreground">
            {!notifyAvailable && "No notifier was found on this system (notify-send, or PowerShell on WSL). "}
            Notify when a node waits for input, approval, or finished a turn (notify-send on Linux, a toast on WSL).
          </p>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={settings?.bypassPermissions ?? false}
            disabled={!settings}
            onCheckedChange={(v) => save({ bypassPermissions: v === true })}
            onSelect={(e) => e.preventDefault()}
          >
            Bypass permissions
          </DropdownMenuCheckboxItem>
          <p className="px-1.5 py-1 text-[11px] leading-snug text-muted-foreground">
            Claude consoles start in bypassPermissions mode instead of the graph&apos;s default (a node&apos;s own mode
            still wins). Claude no longer asks before running commands or reading outside its worktree.
            {settings?.bypassPermissions && (
              <span className="text-amber-600/90"> On: a step can push or approve its own gates without asking you.</span>
            )}
          </p>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setVoiceOpen(true)}>
            <MicIcon /> Voice dictation…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLinearOpen(true)}>
            <Icons.plug /> Linear…
          </DropdownMenuItem>
          {daemon && (
            <>
              <DropdownMenuSeparator />
              <div className="space-y-1 px-1.5 py-1 text-[11px] text-muted-foreground">
                {repoPath && (
                  <div className="truncate font-mono" title={repoPath}>
                    {repoPath}
                  </div>
                )}
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
      {voiceOpen && <VoiceSettingsDialog onClose={() => setVoiceOpen(false)} />}
      {linearOpen && <LinearSettingsDialog onClose={() => setLinearOpen(false)} />}
    </>
  );
}
