import { useAppStore } from "../../store/app-store";
import { Separator } from "../ui/separator";
import { ClaudeSetupButton } from "../claude/ClaudeSetupWizard";
import { SettingsMenu } from "../settings/SettingsMenu";
import { GraphSelector } from "./GraphSelector";
import { PendingApprovals, RunSelector } from "./RunControls";

/** Top bar (§13): logo, graph selector, run selector, pending approvals, settings. Run/Cancel and the save state float over the canvas. */
export function Header() {
  const repo = useAppStore((s) => s.repo);
  const connected = useAppStore((s) => s.connected);
  const sessionExpired = useAppStore((s) => s.sessionExpired);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card/80 px-3 backdrop-blur">
      <div className="flex items-center gap-2 pr-1">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight text-foreground">promptgraph</span>
        {repo && <span className="hidden max-w-40 truncate text-xs text-muted-foreground lg:inline" title={repo.path}>{repo.name}</span>}
      </div>
      <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />
      <GraphSelector />
      <RunSelector />
      <div className="ml-auto flex items-center gap-2">
        {sessionExpired ? (
          <span role="alert" className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-700">
            The promptgraph server was restarted: open the new URL it printed in your terminal.
          </span>
        ) : (
          !connected && <span className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700">Reconnecting…</span>
        )}
        <PendingApprovals />
        <ClaudeSetupButton />
        <SettingsMenu />
      </div>
    </header>
  );
}

/** App logo: a staircase of three joined nodes on a white tile (source artwork in docs/assets/logo.png). */
function Logo() {
  return (
    <svg viewBox="0 0 100 100" width="24" height="24" aria-hidden="true" className="rounded-[5px] shadow-soft ring-1 ring-border">
      <rect width="100" height="100" rx="20" fill="#fff" />
      <path fill="#0a0a0a" d="M14 73V64A6 6 0 0 1 20 58H31A5 5 0 0 0 36 53V46A6 6 0 0 1 42 40H53A5 5 0 0 0 58 35V26A6 6 0 0 1 64 20H76A6 6 0 0 1 82 26V36A6 6 0 0 1 76 42H64A5 5 0 0 0 59 47V55A6 6 0 0 1 53 61H42A5 5 0 0 0 37 66V73A6 6 0 0 1 31 79H20A6 6 0 0 1 14 73Z" />
    </svg>
  );
}
