import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppSettingsStore } from "../config/app-settings.js";
import type { BusEvents, EventBus } from "../events/bus.js";

export type NotifyPlatform = "linux" | "wsl" | "none";

const SEND_TIMEOUT_MS = 10_000;
const BODY_MAX = 200;
/** PowerShell's own AppUserModelID: toasts from unregistered app ids are silently dropped on Windows 10+. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** "wsl" when /proc/version mentions Microsoft; "linux" when notify-send is on PATH; otherwise "none". */
export async function detectNotifyPlatform(env: NodeJS.ProcessEnv = process.env): Promise<NotifyPlatform> {
  try {
    const version = await fs.promises.readFile("/proc/version", "utf8");
    if (/microsoft/i.test(version)) return "wsl";
  } catch {
    // Not Linux, or /proc unavailable.
  }
  return (await onPath("notify-send", env)) ? "linux" : "none";
}

async function onPath(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      await fs.promises.access(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

/** Single-quoted PowerShell string literal. */
function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function wslToastScript(title: string, body: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$x = $t.GetElementsByTagName('text')",
    `$x.Item(0).AppendChild($t.CreateTextNode(${psString(title)})) > $null`,
    `$x.Item(1).AppendChild($t.CreateTextNode(${psString(body)})) > $null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
  ].join("; ");
}

/**
 * Fire-and-forget OS notification: linux → `notify-send -a promptgraph <title> <body>`; wsl →
 * `powershell.exe -NoProfile -Command <toast script>` (Windows.UI.Notifications toast, no modules);
 * failures are swallowed.
 */
export function sendDesktopNotification(platform: NotifyPlatform, title: string, body: string): Promise<void> {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const t = oneLine(title);
  const b = oneLine(body).slice(0, BODY_MAX);
  const command: [string, string[]] | null =
    platform === "linux"
      ? ["notify-send", ["-a", "promptgraph", t, b]]
      : platform === "wsl"
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wslToastScript(t, b)]]
        : null;
  if (!command) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const child = spawn(command[0], command[1], { stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGKILL"), SEND_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.on("error", done);
      child.on("close", done);
    } catch {
      resolve();
    }
  });
}

type Attention = BusEvents["attention"];

export function attentionText(e: Attention): { title: string; body: string } {
  const label = e.nodeLabel || e.nodeRun.nodeId;
  const what =
    e.kind === "waiting_input" ? "needs your input" : e.kind === "waiting_approval" ? "is waiting for approval" : "finished a turn";
  const fallback =
    e.kind === "waiting_input" ? "Answer in its terminal." : e.kind === "waiting_approval" ? "Review and approve or reject." : "Click Done when it is finished.";
  return { title: `promptgraph: ${label} ${what}`, body: `${e.graphName}: ${e.message || fallback}` };
}

export interface NotifierDeps {
  bus: EventBus;
  settings: AppSettingsStore;
  /** Test seams. */
  detect?: () => Promise<NotifyPlatform>;
  send?: typeof sendDesktopNotification;
}

/** Subscribes to bus `attention` and notifies when AppSettings.notifications is on (§18 Q2). */
export class Notifier {
  private platform: Promise<NotifyPlatform> | null = null;

  constructor(private readonly deps: NotifierDeps) {}

  /** Returns a stop function. */
  start(): () => void {
    return this.deps.bus.on("attention", (e) => void this.notify(e));
  }

  private async notify(e: Attention): Promise<void> {
    try {
      if (!this.deps.settings.get().notifications) return;
      this.platform ??= (this.deps.detect ?? detectNotifyPlatform)();
      const platform = await this.platform;
      const { title, body } = attentionText(e);
      await (this.deps.send ?? sendDesktopNotification)(platform, title, body);
    } catch {
      // Notifications are best effort.
    }
  }
}
