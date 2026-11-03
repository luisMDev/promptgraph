import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useDaemonStore } from "../../store/daemon-store";
import { Icons } from "./icons";

/**
 * Connection and version state (DESIGN §13.5), above every view: "Reconnecting…" while the socket is down,
 * "not reachable" after 15 s (it keeps retrying), and a banner when the daemon runs another version than this
 * web build.
 */
export function SessionBanners() {
  const connection = useDaemonStore((s) => s.connection);
  const versionMismatch = useDaemonStore((s) => s.versionMismatch);
  return (
    <>
      {connection === "reconnecting" && (
        <SessionBanner tone="info">
          <span role="status">Reconnecting…</span>
        </SessionBanner>
      )}
      {connection === "unreachable" && (
        <SessionBanner tone="error">
          <span role="alert">
            promptgraph is not reachable — run <Code>promptgraph open</Code> in a terminal.
          </span>
        </SessionBanner>
      )}
      {versionMismatch && (
        <SessionBanner tone="warning">
          <span role="alert">
            promptgraph was updated: run <Code>promptgraph stop</Code> and open it again.
          </span>
        </SessionBanner>
      )}
    </>
  );
}

/** The session is gone (401, or the socket closed with 4401): the page stops retrying. */
export function SignedOut() {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <p className="text-sm font-medium text-foreground">Signed out</p>
      <p className="max-w-lg text-xs text-muted-foreground">
        Run <Code>promptgraph open</Code> in a terminal to sign this browser in again.
      </p>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{children}</code>;
}

function SessionBanner({ tone, children }: { tone: "info" | "warning" | "error"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs",
        tone === "info" && "border-amber-500/30 bg-amber-500/10 text-amber-700",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-700",
        tone === "error" && "border-red-500/30 bg-red-500/10 text-red-700",
      )}
    >
      {tone !== "info" && <Icons.alert className="shrink-0" />}
      {children}
    </div>
  );
}
