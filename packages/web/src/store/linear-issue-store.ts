import { LINEAR_MAX_STATE_IDS, LINEAR_STATE_TTL_MS, type LinearIssue } from "@promptgraph/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { daemonApi } from "../api/rest";
import { useLinearStore } from "./linear-store";

/**
 * Current state of the linked Linear issues the page shows (DESIGN §24.3): the diagram's header and the overview's
 * cards. Ids asked for in the same tick go to the daemon as one GET /api/linear/issue-states (in chunks of
 * LINEAR_MAX_STATE_IDS); an answer is kept for LINEAR_STATE_TTL_MS. Nothing is asked while Linear is not connected.
 * A failed request leaves the ids without a state (the UI then shows the snapshot from the graph file) until the TTL.
 */
export interface IssueStateEntry {
  /** null: Linear does not know the issue (deleted, another workspace) or the request failed. */
  issue: LinearIssue | null;
  failed: boolean;
  at: number;
}

interface LinearIssueState {
  entries: Record<string, IssueStateEntry>;
}

export const useLinearIssueStore = create<LinearIssueState>()(() => ({ entries: {} }));

let queue = new Set<string>();
let scheduled = false;
const inflight = new Set<string>();
let now = () => Date.now();

function isFresh(id: string): boolean {
  const e = useLinearIssueStore.getState().entries[id];
  return !!e && now() - e.at < LINEAR_STATE_TTL_MS;
}

async function flush(): Promise<void> {
  scheduled = false;
  const ids = [...queue].filter((id) => !inflight.has(id) && !isFresh(id));
  queue = new Set();
  if (!ids.length) return;
  await useLinearStore.getState().load();
  if (useLinearStore.getState().status?.connected !== true) return;
  for (const id of ids) inflight.add(id);
  for (let i = 0; i < ids.length; i += LINEAR_MAX_STATE_IDS) {
    const chunk = ids.slice(i, i + LINEAR_MAX_STATE_IDS);
    let found: Map<string, LinearIssue> | null = null;
    try {
      found = new Map((await daemonApi.linearIssueStates(chunk)).issues.map((issue) => [issue.id, issue]));
    } catch {
      found = null;
    }
    const at = now();
    useLinearIssueStore.setState((s) => {
      const entries = { ...s.entries };
      for (const id of chunk) entries[id] = { issue: found?.get(id) ?? null, failed: found === null, at };
      return { entries };
    });
    for (const id of chunk) inflight.delete(id);
  }
}

/** Asks for the current state of `id` (batched with the other ids of this tick) unless a fresh answer is cached. */
export function requestIssueState(id: string): void {
  if (isFresh(id) || inflight.has(id)) return;
  queue.add(id);
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => void flush(), 0);
}

/** The cached state of a linked issue (requested on mount and when `id` changes); undefined until it is known. */
export function useLinearIssueState(id: string | undefined): IssueStateEntry | undefined {
  const entry = useLinearIssueStore((s) => (id ? s.entries[id] : undefined));
  // Asked again once Linear gets connected (nothing is asked before).
  const connected = useLinearStore((s) => s.status?.connected === true);
  useEffect(() => {
    if (id) requestIssueState(id);
  }, [id, connected]);
  return entry;
}

/** Tests: forget every answer; `clock` replaces Date.now. */
export function resetLinearIssueStore(clock: () => number = () => Date.now()): void {
  queue = new Set();
  scheduled = false;
  inflight.clear();
  now = clock;
  useLinearIssueStore.setState({ entries: {} });
}
