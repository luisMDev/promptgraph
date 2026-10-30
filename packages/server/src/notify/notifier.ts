import type { AppSettingsStore } from "../config/app-settings.js";
import type { EventBus } from "../events/bus.js";

export type NotifyPlatform = "linux" | "wsl" | "none";

/** "wsl" when /proc/version mentions Microsoft; "linux" when notify-send is on PATH; otherwise "none". */
export function detectNotifyPlatform(): Promise<NotifyPlatform> {
  throw new Error("not implemented");
}

/**
 * Fire-and-forget OS notification: linux → `notify-send -a promptgraph <title> <body>`; wsl →
 * `powershell.exe -NoProfile -Command <toast script>` (Windows.UI.Notifications toast, no modules);
 * failures are swallowed.
 */
export function sendDesktopNotification(platform: NotifyPlatform, title: string, body: string): Promise<void> {
  throw new Error("not implemented");
}

/** Subscribes to bus `attention` and notifies when AppSettings.notifications is on (§18 Q2). */
export class Notifier {
  constructor(private readonly deps: { bus: EventBus; settings: AppSettingsStore }) {}

  /** Returns a stop function. */
  start(): () => void {
    throw new Error("not implemented");
  }
}
