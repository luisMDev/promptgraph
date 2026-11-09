import type { GraphIssue } from "@promptgraph/shared";
import { describe, expect, it, vi } from "vitest";
import { CHAT_ISSUE_TTL_MS, createLinkedIssuesResolver } from "../src/chat/issues.js";
import type { LinearIssueContext } from "../src/linear/client.js";
import { LinearNotConnectedError } from "../src/linear/service.js";

const linked: GraphIssue[] = [
  { provider: "linear", id: "id-1", identifier: "ENG-1", title: "Old title", url: "https://linear.app/x/issue/ENG-1" },
  { provider: "linear", id: "id-2", identifier: "ENG-2", title: "Gone", url: "https://linear.app/x/issue/ENG-2" },
];
const live: LinearIssueContext = {
  issueId: "id-1",
  identifier: "ENG-1",
  title: "New title",
  url: "https://linear.app/x/issue/ENG-1",
  description: "Build the login page.",
  currentState: { id: "s", name: "In Progress", type: "started", color: "#fff" },
  states: [],
};

describe("createLinkedIssuesResolver", () => {
  it("completes the graph's issues from Linear and caches them", async () => {
    let t = 0;
    const issueContext = vi.fn(async () => [live]);
    const resolve = createLinkedIssuesResolver({ graphIssues: () => linked, issueContext, now: () => t });
    const first = await resolve("g");
    expect(first).toEqual({
      issues: [
        { identifier: "ENG-1", title: "New title", url: live.url, state: "In Progress", description: "Build the login page." },
        // Linear does not know it: the graph's snapshot.
        { identifier: "ENG-2", title: "Gone", url: linked[1]!.url },
      ],
    });
    await resolve("g");
    expect(issueContext).toHaveBeenCalledTimes(1);
    t = CHAT_ISSUE_TTL_MS;
    await resolve("g");
    expect(issueContext).toHaveBeenCalledTimes(2);
  });

  it("returns no issues for a graph without links, without asking Linear", async () => {
    const issueContext = vi.fn(async () => []);
    const resolve = createLinkedIssuesResolver({ graphIssues: () => [], issueContext });
    expect(await resolve("g")).toEqual({ issues: [] });
    expect(issueContext).not.toHaveBeenCalled();
  });

  it("falls back to the snapshot with a note when Linear is not connected, fails or is slow", async () => {
    const notConnected = createLinkedIssuesResolver({ graphIssues: () => linked, issueContext: async () => Promise.reject(new LinearNotConnectedError()) });
    const a = await notConnected("g");
    expect(a.issues.map((i) => i.title)).toEqual(["Old title", "Gone"]);
    expect(a.note).toMatch(/not connected/);
    const slow = createLinkedIssuesResolver({ graphIssues: () => linked, issueContext: () => new Promise(() => {}), timeoutMs: 10 });
    expect((await slow("g")).note).toMatch(/could not be asked .*no answer/);
  });
});
