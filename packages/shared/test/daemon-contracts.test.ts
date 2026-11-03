import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  DaemonHelloResponseSchema,
  DaemonInfoSchema,
  emptyUsage,
  isSafeNextPath,
  ListReposResponseSchema,
  loginUrl,
  normalizePath,
  OpenUrlResultSchema,
  REPO_ID_PATTERN,
  RepoSummarySchema,
  safeRedirectTarget,
  ServerMessageSchema,
  SessionSummarySchema,
  webRoutes,
  type RepoSummary,
  type RunSummary,
} from "../src/index.js";

const REPO_ID = "promptgraph-3f9a1c2e";
const ORIGIN = "http://127.0.0.1:4777";

const summary: RepoSummary = {
  id: REPO_ID,
  path: "/home/u/promptgraph",
  name: "promptgraph",
  available: true,
  active: false,
  error: null,
  addedAt: 1,
  lastOpenedAt: null,
  lastRunAt: null,
  runs: { running: 0, paused: 1 },
  waiting: { approval: 0, input: 2 },
};

const run: RunSummary = {
  id: "r1",
  repoPath: "/home/u/promptgraph",
  graphId: "g",
  graphName: "G",
  status: "running",
  startedAt: 1,
  finishedAt: null,
  graphHash: "h",
  shortId: "3f9a",
  error: null,
  pendingApprovals: 0,
  waitingInput: 0,
  usage: emptyUsage(),
  cleanedUp: false,
};

describe("repository ids and summaries", () => {
  it("REPO_ID_PATTERN accepts <slug>-<hash8> only", () => {
    for (const ok of [REPO_ID, "repo-00000000", "a-0123abcd", "my-app-2-deadbeef", `${"a".repeat(24)}-0123abcd`]) {
      expect(REPO_ID_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ["promptgraph", "-0123abcd", "a-0123abcdx", "Repo-0123abcd", "a-0123abc", "a-0123ABCD", `${"a".repeat(25)}-0123abcd`, "a_b-0123abcd", "a-b-", "../x-0123abcd"]) {
      expect(REPO_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("RepoSummary carries the activation error", () => {
    expect(RepoSummarySchema.parse(summary)).toEqual(summary);
    expect(RepoSummarySchema.parse({ ...summary, error: "ENOSPC" }).error).toBe("ENOSPC");
    expect(RepoSummarySchema.safeParse({ ...summary, error: undefined }).success).toBe(false);
    expect(ListReposResponseSchema.parse({ repos: [summary] }).repos).toHaveLength(1);
  });

  it("daemon record, hello and sessions", () => {
    const info = { version: 2, pid: 10, pidStart: 1234, port: 4777, serverVersion: "0.1.0", startedAt: 5 };
    expect(DaemonInfoSchema.parse(info)).toEqual(info);
    expect(DaemonInfoSchema.safeParse({ ...info, version: 1 }).success).toBe(false);
    expect(DaemonInfoSchema.safeParse({ ...info, pidStart: undefined }).success).toBe(false);
    expect(DaemonHelloResponseSchema.parse({ pid: 10, serverVersion: "0.1.0", proof: "abc" }).proof).toBe("abc");
    const s = { id: "0123abcd", label: "Firefox", createdAt: 1, lastSeenAt: 2, expiresAt: 3, current: true };
    expect(SessionSummarySchema.parse(s)).toEqual(s);
    expect(SessionSummarySchema.safeParse({ ...s, id: "0123abc" }).success).toBe(false);
  });
});

describe("WebSocket protocol", () => {
  it("run:update and graphs:changed carry the repository id", () => {
    expect(ServerMessageSchema.parse({ type: "run:update", repoId: REPO_ID, run })).toMatchObject({ repoId: REPO_ID });
    expect(ServerMessageSchema.safeParse({ type: "run:update", run }).success).toBe(false);
    expect(ServerMessageSchema.parse({ type: "graphs:changed", repoId: REPO_ID, graphId: "g" })).toMatchObject({ repoId: REPO_ID });
    expect(ServerMessageSchema.safeParse({ type: "graphs:changed", graphId: "g" }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "graphs:changed", repoId: "not an id", graphId: "g" }).success).toBe(false);
  });

  it("repo:status, repo:removed, repo:subscribe and repo:unsubscribe", () => {
    expect(ServerMessageSchema.parse({ type: "repo:status", repo: summary })).toEqual({ type: "repo:status", repo: summary });
    expect(ServerMessageSchema.parse({ type: "repo:removed", repoId: REPO_ID }).type).toBe("repo:removed");
    expect(ClientMessageSchema.parse({ type: "repo:subscribe", repoId: REPO_ID }).type).toBe("repo:subscribe");
    expect(ClientMessageSchema.parse({ type: "repo:unsubscribe", repoId: REPO_ID }).type).toBe("repo:unsubscribe");
    expect(ClientMessageSchema.safeParse({ type: "repo:subscribe", repoId: "../etc" }).success).toBe(false);
  });
});

describe("web routes", () => {
  it("builds every route with encoded segments", () => {
    expect(webRoutes.home()).toBe("/");
    expect(webRoutes.repo(REPO_ID)).toBe(`/r/${REPO_ID}`);
    expect(webRoutes.graph(REPO_ID, "my graph/x")).toBe(`/r/${REPO_ID}/graphs/my%20graph%2Fx`);
    expect(webRoutes.run(REPO_ID, "r?1")).toBe(`/r/${REPO_ID}/runs/r%3F1`);
    expect(webRoutes.nodeRun(REPO_ID, "r1", "n#1")).toBe(`/r/${REPO_ID}/runs/r1/nodes/n%231`);
    expect(webRoutes.report(REPO_ID, "r1")).toBe(`/r/${REPO_ID}/runs/r1/report`);
  });

  it("normalizePath strips trailing slashes and canonicalises percent-encoding", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/r/x/")).toBe("/r/x");
    expect(normalizePath("/r/x//")).toBe("/r/x");
    expect(normalizePath("/r/x/graphs/a b")).toBe("/r/x/graphs/a%20b");
    expect(normalizePath("/r/x/graphs/a%20b")).toBe("/r/x/graphs/a%20b");
    expect(normalizePath("/r/x/graphs/%7Ea")).toBe("/r/x/graphs/~a");
    expect(normalizePath("/r/x/graphs/%61")).toBe("/r/x/graphs/a");
    expect(normalizePath("/r/x/graphs/%zz")).toBe("/r/x/graphs/%zz");
    expect(normalizePath(webRoutes.graph(REPO_ID, "a b"))).toBe(webRoutes.graph(REPO_ID, "a b"));
  });
});

describe("login redirects", () => {
  it("isSafeNextPath accepts same-origin paths only", () => {
    for (const ok of ["/", "/r/x", "/r/x/runs/1?tab=2#n", "/%5C%5Cevil"]) expect(isSafeNextPath(ok), ok).toBe(true);
    for (const bad of ["//evil", "/\\evil", "/\tevil", " /x", "/x y", "/x\n", "/ x", "http://x", "javascript:alert(1)", "", "r/x", null, undefined]) {
      expect(isSafeNextPath(bad), String(bad)).toBe(false);
    }
  });

  it("safeRedirectTarget keeps the daemon origin", () => {
    expect(safeRedirectTarget("/r/x", ORIGIN)).toBe("/r/x");
    const encoded = safeRedirectTarget("/%5C%5Cevil", ORIGIN);
    expect(new URL(encoded, ORIGIN).origin).toBe(ORIGIN);
    expect(encoded).toBe("/%5C%5Cevil");
    expect(safeRedirectTarget("/a/../b", ORIGIN)).toBe("/b");
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      " /x",
      "/\tevil",
      "http://evil.com",
      "",
      null,
      "/..//evil.com",
      "/.//evil.com",
      "/a/..//evil.com",
      "/%2e%2e//evil.com",
    ]) {
      expect(safeRedirectTarget(bad, ORIGIN), String(bad)).toBe("/");
    }
  });

  it("loginUrl encodes the code and the next path", () => {
    expect(loginUrl(ORIGIN, "a+b/c", "/r/x?y=1")).toBe(`${ORIGIN}/login?code=a%2Bb%2Fc&next=%2Fr%2Fx%3Fy%3D1`);
  });
});

describe("desktop contract", () => {
  it("OpenUrlResult is version 1", () => {
    const ok = { v: 1, cliVersion: "0.1.0", url: `${ORIGIN}/login?code=x&next=%2F`, port: 4777, repoId: null };
    expect(OpenUrlResultSchema.parse(ok)).toEqual(ok);
    expect(OpenUrlResultSchema.parse({ ...ok, repoId: REPO_ID }).repoId).toBe(REPO_ID);
    expect(OpenUrlResultSchema.safeParse({ ...ok, v: 2 }).success).toBe(false);
    expect(OpenUrlResultSchema.safeParse({ ...ok, url: "not a url" }).success).toBe(false);
    expect(OpenUrlResultSchema.safeParse({ ...ok, repoId: "bad" }).success).toBe(false);
  });
});
