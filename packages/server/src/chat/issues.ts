import type { ChatIssue, GraphIssue } from "@promptgraph/shared";
import type { LinearIssueContext } from "../linear/client.js";
import { LinearNotConnectedError } from "../linear/service.js";
import { errorMessage } from "../util/text.js";
import type { LinkedIssues } from "./chat-manager.js";

/** How long a looked-up issue (description, state) is reused by the chat. */
export const CHAT_ISSUE_TTL_MS = 2 * 60_000;
/** Longest wait for Linear before a turn is sent with the graph file's snapshot instead. */
export const CHAT_ISSUE_TIMEOUT_MS = 4_000;

export interface LinkedIssuesDeps {
  /** The issues linked in the graph file (`Graph.issues`), [] when none. @throws when the graph cannot be read */
  graphIssues(graphId: string): GraphIssue[];
  /** LinearService.issueContext. @throws LinearNotConnectedError, LinearApiError */
  issueContext(ids: readonly string[]): Promise<LinearIssueContext[]>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The chat's view of a graph's linked issues (DESIGN §21.3, §24): read from the graph file, completed with the
 * description and current state from Linear (cached CHAT_ISSUE_TTL_MS). Without a Linear connection, on a failure or
 * after CHAT_ISSUE_TIMEOUT_MS, the snapshot in the graph file is used, with a note saying why.
 */
export function createLinkedIssuesResolver(deps: LinkedIssuesDeps): (graphId: string) => Promise<LinkedIssues> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CHAT_ISSUE_TIMEOUT_MS;
  const cache = new Map<string, { at: number; issue: LinearIssueContext | null }>();

  return async (graphId) => {
    const linked = deps.graphIssues(graphId);
    if (linked.length === 0) return { issues: [] };
    const t = now();
    const missing = linked.filter((i) => {
      const hit = cache.get(i.id);
      return !hit || t - hit.at >= CHAT_ISSUE_TTL_MS;
    });
    let note: string | undefined;
    if (missing.length) {
      try {
        const found = new Map((await withTimeout(deps.issueContext(missing.map((i) => i.id)), timeoutMs)).map((c) => [c.issueId, c]));
        for (const issue of missing) cache.set(issue.id, { at: t, issue: found.get(issue.id) ?? null });
      } catch (err) {
        note =
          err instanceof LinearNotConnectedError
            ? "Linear is not connected in promptgraph, so only the titles saved in the graph are known."
            : `Linear could not be asked (${errorMessage(err)}), so only the titles saved in the graph are known.`;
      }
    }
    const issues = linked.map((snapshot): ChatIssue => {
      const live = cache.get(snapshot.id)?.issue;
      if (!live) return { identifier: snapshot.identifier, title: snapshot.title, url: snapshot.url };
      return {
        identifier: live.identifier,
        title: live.title,
        url: live.url,
        ...(live.currentState ? { state: live.currentState.name } : {}),
        ...(live.description ? { description: live.description } : {}),
      };
    });
    return note ? { issues, note } : { issues };
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
