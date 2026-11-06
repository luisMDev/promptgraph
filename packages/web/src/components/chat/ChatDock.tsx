import type { ChatSessionSummary } from "@promptgraph/shared";
import { HistoryIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { onChatShortcut } from "../../lib/chat-shortcut";
import { formatDateTime } from "../../lib/format";
import { closeChat, dropDeleted, minimizeChats, openChat, shortcutTarget, toggleChat } from "../../store/chat-dock";
import { getChatStore, isBusy, useRepoChat } from "../../store/chat-store";
import type { TabChats } from "../../store/tabs-store";
import { useView } from "../../store/view/context";
import { useTabContext } from "../tabs/tab-context";
import { Button } from "../common/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ChatWindow, chatTitle } from "./ChatPanel";

/** The tab's chats (persisted with the tab); outside the tabbed app (tests) a local state stands in. */
function useTabChats(): [TabChats | null, (next: TabChats | null) => void] {
  const tab = useTabContext();
  const [local, setLocal] = useState<TabChats | null>(null);
  return tab ? [tab.chats, tab.setChats] : [local, setLocal];
}

/**
 * The chats of a repository tab (DESIGN §21.11): a button per chat in the tab's bottom bar, "New chat" (Ctrl+J) and the
 * chat history; the open chat floats above the panel as a ChatWindow. At most one window is open per tab.
 */
export function ChatDock() {
  const view = useView();
  const tab = useTabContext();
  const active = tab?.active ?? true;
  const chatApi = getChatStore(view.repoId);
  const [stored, setChats] = useTabChats();
  // Chats of another repository (a tab that navigated) are not this view's.
  const chats = stored && stored.repoId === view.repoId ? stored : null;
  const sessions = useRepoChat(view.repoId, (s) => s.sessions);
  const sessionsLoaded = useRepoChat(view.repoId, (s) => s.sessionsLoaded);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!chatApi.getState().sessionsLoaded) void chatApi.getState().loadSessions();
  }, [chatApi]);

  // The open window's session: its items are fetched once, then live.
  const openId = chats?.open ?? null;
  useEffect(() => {
    if (openId) void chatApi.getState().openSession(openId);
  }, [chatApi, openId]);

  // A deleted session (here or elsewhere) leaves the bar.
  useEffect(() => {
    if (!sessionsLoaded || !chats) return;
    const next = dropDeleted(chats, (id) => sessions.some((s) => s.id === id));
    if (next !== chats) setChats(next);
  }, [sessionsLoaded, sessions, chats, setChats]);

  const newChat = async () => {
    const id = await chatApi.getState().newSession();
    if (id) setChats(openChat(chats, view.repoId, id));
  };
  const show = (id: string) => setChats(openChat(chats, view.repoId, id));

  useEffect(() => {
    if (!active) return;
    return onChatShortcut(() => {
      const target = shortcutTarget(chats);
      if (target.kind === "minimize" && chats) setChats(minimizeChats(chats));
      else if (target.kind === "open") show(target.id);
      else void newChat();
    });
  });

  const bar = (
    <ChatBar
      chats={chats}
      sessions={sessions}
      onToggle={(id) => chats && setChats(toggleChat(chats, id))}
      onClose={(id) => chats && setChats(closeChat(chats, id))}
      onNew={() => void newChat()}
      onPick={show}
    />
  );

  return (
    <>
      {openId && chats && (
        <ChatWindow
          key={openId}
          sessionId={openId}
          actions={{
            onMinimize: () => setChats(minimizeChats(chats)),
            onClose: () => setChats(closeChat(chats, openId)),
            expanded,
            onToggleExpanded: () => setExpanded((e) => !e),
          }}
        />
      )}
      {tab?.bottomBar ? createPortal(bar, tab.bottomBar) : !tab && <div className="flex h-9 items-center justify-end gap-1 px-1">{bar}</div>}
    </>
  );
}

function ChatBar({
  chats,
  sessions,
  onToggle,
  onClose,
  onNew,
  onPick,
}: {
  chats: TabChats | null;
  sessions: ChatSessionSummary[];
  onToggle(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  onPick(id: string): void;
}) {
  return (
    <div role="toolbar" aria-label="Chats" className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {chats?.ids.map((id) => (
          <ChatBarItem key={id} session={sessions.find((s) => s.id === id)} open={chats.open === id} onToggle={() => onToggle(id)} onClose={() => onClose(id)} />
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="New chat" className="h-7 shrink-0 gap-1.5 px-2 text-xs" onClick={onNew}>
            <SquarePenIcon /> Ask Claude
          </Button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          New chat
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>J</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <ChatHistory sessions={sessions} onPick={onPick} />
    </div>
  );
}

function ChatBarItem({ session, open, onToggle, onClose }: { session: ChatSessionSummary | undefined; open: boolean; onToggle(): void; onClose(): void }) {
  const title = chatTitle(session);
  const status = session?.status;
  return (
    <div className={cn("group flex h-7 max-w-52 shrink-0 items-center rounded-md border", open ? "border-border bg-accent text-foreground" : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground")}>
      <button type="button" aria-pressed={open} aria-label={`${open ? "Minimize" : "Open"} chat ${title}`} title={title} className="flex min-w-0 items-center gap-1.5 pr-1 pl-2.5 text-xs" onClick={onToggle}>
        {status && (isBusy(status) || status === "waiting_permission") && (
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", status === "waiting_permission" ? "bg-amber-500" : "animate-pulse bg-primary")} />
        )}
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close chat ${title}`}
        title="Close (the chat stays in the history)"
        className="mr-1 flex size-4 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-70 hover:bg-background focus-visible:opacity-70"
        onClick={onClose}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

function ChatHistory({ sessions, onPick }: { sessions: ChatSessionSummary[]; onPick(id: string): void }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Chat history" className="shrink-0 text-muted-foreground">
              <HistoryIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Chat history</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="max-h-96 w-80 overflow-y-auto">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Chats in this repository</DropdownMenuLabel>
        {sessions.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No chats yet.</p>}
        {sessions.map((s) => (
          <DropdownMenuItem key={s.id} className="flex-col items-start gap-0" onSelect={() => onPick(s.id)}>
            <span className="w-full truncate">{chatTitle(s)}</span>
            <span className="text-[11px] text-muted-foreground">{formatDateTime(s.updatedAt)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

