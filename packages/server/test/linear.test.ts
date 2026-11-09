import fs from "node:fs";
import path from "node:path";
import { createEmptyGraph, LINEAR_ERROR, type LinearIssue } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPaths, graphsDir } from "../src/config/paths.js";
import { createHttpApp } from "../src/http/app.js";
import { LinearApiError, LinearClient, LINEAR_GRAPHQL_URL, type LinearFetch } from "../src/linear/client.js";
import { linearKeyPath, readLinearKey, writeLinearKey } from "../src/linear/key-store.js";
import { LinearNotConnectedError, LinearService } from "../src/linear/service.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { createTestDaemon, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

vi.mock("../src/git/repo.js", async (orig) => ({
  ...(await orig<typeof import("../src/git/repo.js")>()),
  currentBranch: vi.fn(async () => "main"),
  listBranches: vi.fn(async () => ["main"]),
}));

const KEY = "lin_api_secret_value_0123456789";

const RAW_ISSUE = {
  id: "9c1a7e2e-0000-4000-8000-000000000001",
  identifier: "ENG-123",
  title: "Add Linear issues to new graphs",
  url: "https://linear.app/acme/issue/ENG-123/add-linear-issues-to-new-graphs",
  branchName: "luis/eng-123-add-linear-issues-to-new-graphs",
  state: { name: "Todo", type: "unstarted", color: "#e2e2e2" },
  team: { key: "ENG" },
  assignee: { name: "Luis" },
};

const ISSUE: LinearIssue = {
  provider: "linear",
  id: RAW_ISSUE.id,
  identifier: "ENG-123",
  title: RAW_ISSUE.title,
  url: RAW_ISSUE.url,
  branchName: RAW_ISSUE.branchName,
  state: RAW_ISSUE.state,
  teamKey: "ENG",
  assignee: "Luis",
};

interface Call {
  url: string;
  authorization: string;
  query: string;
  variables: Record<string, unknown>;
}

/** A fake Linear API: `answer` maps the GraphQL query to a (status, body). Records every call. */
function fakeLinear(answer: (query: string, variables: Record<string, unknown>, key: string) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch: LinearFetch = async (url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push({ url, authorization: init.headers.Authorization!, query, variables });
    const { status = 200, body } = answer(query, variables, init.headers.Authorization!);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

/** Linear as it answers a valid KEY: viewer, assigned issues, search and lookup. */
function linearFor(validKey = KEY) {
  return fakeLinear((query, variables, key) => {
    if (key !== validKey) return { status: 400, body: { errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR" } }] } };
    if (query.includes("organization")) return { body: { data: { viewer: { name: "Luis", email: "luis@example.com" }, organization: { name: "Acme", urlKey: "acme" } } } };
    if (query.includes("assignedIssues")) return { body: { data: { viewer: { assignedIssues: { nodes: [RAW_ISSUE] } } } } };
    if (query.includes("searchIssues")) return { body: { data: { searchIssues: { nodes: variables.term === "linear" ? [RAW_ISSUE, { id: "x", identifier: "bad" }] : [] } } } };
    if (query.includes("issues(first") && !variables.ids) return { body: { data: { issues: { nodes: [RAW_ISSUE] } } } };
    if (query.includes("issues(first")) {
      const ids = variables.ids as string[];
      return { body: { data: { issues: { nodes: ids.includes(RAW_ISSUE.id) ? [RAW_ISSUE] : [] } } } };
    }
    if (query.includes("issue(id")) {
      return variables.id === "ENG-123" ? { body: { data: { issue: RAW_ISSUE } } } : { body: { data: null, errors: [{ message: "Entity not found: Issue" }] } };
    }
    return { status: 500, body: {} };
  });
}

describe("Linear key store", () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeEach(() => (tmp = tempDir()));
  afterEach(() => tmp.cleanup());

  it("writes the key with mode 0600 and reads it back; an empty file is no key", () => {
    const paths = getPaths({ PG_HOME: tmp.dir });
    expect(readLinearKey(paths)).toBeNull();
    writeLinearKey(paths, KEY);
    expect(fs.statSync(linearKeyPath(paths)).mode & 0o777).toBe(0o600);
    expect(readLinearKey(paths)).toBe(KEY);
    fs.chmodSync(linearKeyPath(paths), 0o644);
    readLinearKey(paths);
    expect(fs.statSync(linearKeyPath(paths)).mode & 0o777).toBe(0o600);
    fs.writeFileSync(linearKeyPath(paths), "\n");
    expect(readLinearKey(paths)).toBeNull();
  });
});

describe("LinearClient", () => {
  it("sends the personal key as the Authorization header, without Bearer", async () => {
    const linear = linearFor();
    const viewer = await new LinearClient({ fetch: linear.fetch }).viewer(KEY);
    expect(viewer).toEqual({ viewer: { name: "Luis", email: "luis@example.com" }, workspace: { name: "Acme", urlKey: "acme" } });
    expect(linear.calls[0]).toMatchObject({ url: LINEAR_GRAPHQL_URL, authorization: KEY });
  });

  it("maps HTTP 401 and GraphQL authentication errors to unauthorized, without the key in the message", async () => {
    const client = new LinearClient({ fetch: linearFor().fetch });
    const err = await client.viewer("lin_api_wrong").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearApiError);
    expect((err as LinearApiError).kind).toBe("unauthorized");
    expect((err as Error).message).not.toContain("lin_api_wrong");
    const http401 = new LinearClient({ fetch: fakeLinear(() => ({ status: 401, body: {} })).fetch });
    await expect(http401.viewer(KEY)).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("maps network errors, timeouts and odd answers to unavailable", async () => {
    const down = new LinearClient({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.linear.app");
      },
    });
    await expect(down.viewer(KEY)).rejects.toMatchObject({ kind: "unavailable", message: expect.stringContaining("ENOTFOUND") });
    const html = new LinearClient({ fetch: async () => ({ ok: false, status: 502, json: async () => Promise.reject(new SyntaxError("Unexpected token <")) }) });
    await expect(html.viewer(KEY)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("returns issues in the shared shape and drops nodes that do not fit", async () => {
    const client = new LinearClient({ fetch: linearFor().fetch });
    expect(await client.searchIssues(KEY, "linear")).toEqual([ISSUE]);
    expect(await client.assignedIssues(KEY)).toEqual([ISSUE]);
    expect(await client.issue(KEY, "ENG-123")).toEqual(ISSUE);
    expect(await client.issue(KEY, "ENG-999")).toBeNull();
  });
});

describe("LinearClient writes and issue context (§24.5)", () => {
  it("reads issues with their team's states in workflow order", async () => {
    const linear = fakeLinear(() => ({
      body: {
        data: {
          issues: {
            nodes: [
              {
                ...RAW_ISSUE,
                description: null,
                state: { id: "s1", name: "Todo", type: "unstarted", color: "#ccc" },
                team: { states: { nodes: [{ id: "s2", name: "Done", type: "completed", color: "#0c0", position: 3 }, { id: "s1", name: "Todo", type: "unstarted", color: "#ccc", position: 1 }] } },
              },
            ],
          },
        },
      },
    }));
    const [ctx] = await new LinearClient({ fetch: linear.fetch }).issueContext(KEY, [RAW_ISSUE.id]);
    expect(ctx).toEqual({
      issueId: RAW_ISSUE.id,
      identifier: "ENG-123",
      title: RAW_ISSUE.title,
      url: RAW_ISSUE.url,
      description: "",
      currentState: { id: "s1", name: "Todo", type: "unstarted", color: "#ccc" },
      states: [
        { id: "s1", name: "Todo", type: "unstarted", color: "#ccc" },
        { id: "s2", name: "Done", type: "completed", color: "#0c0" },
      ],
    });
  });

  it("creates comments and moves issues, failing when Linear reports no success", async () => {
    let ok = true;
    const linear = fakeLinear((query) => ({ body: { data: query.includes("commentCreate") ? { commentCreate: { success: ok } } : { issueUpdate: { success: ok } } } }));
    const client = new LinearClient({ fetch: linear.fetch });
    await client.createComment(KEY, "i1", "Progress");
    expect(linear.calls.at(-1)).toMatchObject({ authorization: KEY, variables: { issueId: "i1", body: "Progress" } });
    expect(linear.calls.at(-1)!.query).toContain("mutation");
    await client.setIssueState(KEY, "i1", "s2");
    expect(linear.calls.at(-1)!.variables).toEqual({ id: "i1", stateId: "s2" });
    ok = false;
    await expect(client.createComment(KEY, "i1", "x")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(client.setIssueState(KEY, "i1", "s2")).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("LinearService", () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeEach(() => (tmp = tempDir()));
  afterEach(() => tmp.cleanup());

  it("routes the picker query: empty → assigned issues, identifier or URL → lookup, text → search", async () => {
    const linear = linearFor();
    const paths = getPaths({ PG_HOME: tmp.dir });
    const service = new LinearService(paths, new LinearClient({ fetch: linear.fetch }));
    await expect(service.issues("")).rejects.toBeInstanceOf(LinearNotConnectedError);
    writeLinearKey(paths, KEY);
    await service.issues(" ");
    await service.issues("eng-123");
    await service.issues("https://linear.app/acme/issue/ENG-123/some-slug");
    await service.issues("linear");
    expect(linear.calls.map((c) => [c.query.match(/assignedIssues|searchIssues|issue\(id/)?.[0], c.variables.id ?? c.variables.term ?? null])).toEqual([
      ["assignedIssues", null],
      ["issue(id", "ENG-123"],
      ["issue(id", "ENG-123"],
      ["searchIssues", "linear"],
    ]);
    // Lists and searches keep open work unless asked otherwise; a lookup by identifier is never filtered.
    const open = ["triage", "backlog", "unstarted", "started"];
    expect(linear.calls.map((c) => c.variables.states)).toEqual([open, undefined, undefined, open]);
    expect(linear.calls[0]!.query).toContain("filter: { state: { type: { in: $states } } }");
    expect(linear.calls[3]!.query).toContain("filter: { state: { type: { in: $states } } }");
    await service.issues("linear", ["completed"]);
    expect(linear.calls.at(-1)!.variables).toMatchObject({ term: "linear", states: ["completed"] });
  });

  it("scopes lists and searches: mine (assigned) or all (the workspace)", async () => {
    const linear = linearFor();
    const paths = getPaths({ PG_HOME: tmp.dir });
    writeLinearKey(paths, KEY);
    const service = new LinearService(paths, new LinearClient({ fetch: linear.fetch }));
    expect(await service.issues("", undefined, "all")).toEqual([ISSUE]);
    expect(linear.calls.at(-1)!.query).toContain("issues(first: $first, orderBy: updatedAt");
    await service.issues("", undefined, "mine");
    expect(linear.calls.at(-1)!.query).toContain("assignedIssues");
    await service.issues("linear", undefined, "mine");
    expect(linear.calls.at(-1)!.query).toContain("assignee: { isMe: { eq: true } }");
    await service.issues("linear", undefined, "all");
    expect(linear.calls.at(-1)!.query).not.toContain("isMe");
    // A lookup by identifier ignores the scope.
    await service.issues("ENG-123", undefined, "mine");
    expect(linear.calls.at(-1)!.query).toContain("issue(id");
  });

  it("answers linked issues' states from one batched query, cached for a minute", async () => {
    const linear = linearFor();
    let now = 1_000;
    const paths = getPaths({ PG_HOME: tmp.dir });
    const service = new LinearService(paths, new LinearClient({ fetch: linear.fetch }), () => now);
    await expect(service.issuesById([ISSUE.id])).rejects.toBeInstanceOf(LinearNotConnectedError);
    writeLinearKey(paths, KEY);
    expect(await service.issuesById([ISSUE.id, "gone"])).toEqual([ISSUE]);
    expect(linear.calls.at(-1)!.variables).toEqual({ ids: [ISSUE.id, "gone"], first: 2 });
    expect(linear.calls.at(-1)!.query).toContain("filter: { id: { in: $ids } }");
    now += 30_000;
    expect(await service.issuesById(["gone", ISSUE.id])).toEqual([ISSUE]);
    expect(linear.calls).toHaveLength(1);
    now += 31_000;
    await service.issuesById([ISSUE.id]);
    expect(linear.calls).toHaveLength(2);
    // A new key does not reuse the old key's answers.
    service.clearKey();
    writeLinearKey(paths, KEY);
    await service.issuesById([ISSUE.id]);
    expect(linear.calls).toHaveLength(3);
  });

  it("caches the status per key, but not a transient failure", async () => {
    let up = false;
    const viewer = { data: { viewer: { name: "Luis", email: null }, organization: { name: "Acme", urlKey: "acme" } } };
    const linear = fakeLinear(() => (up ? { body: viewer } : { status: 503, body: { errors: [{ message: "Service unavailable" }] } }));
    const paths = getPaths({ PG_HOME: tmp.dir });
    const service = new LinearService(paths, new LinearClient({ fetch: linear.fetch }));
    expect(await service.status()).toEqual({ connected: false, viewer: null, workspace: null, error: null });
    writeLinearKey(paths, KEY);
    expect((await service.status()).error).toBe(LINEAR_ERROR.unavailable);
    up = true;
    expect(await service.status()).toEqual({ connected: true, viewer: { name: "Luis", email: null }, workspace: { name: "Acme", urlKey: "acme" }, error: null });
    await service.status();
    expect(linear.calls).toHaveLength(2);
  });
});

describe("/api/linear routes", () => {
  let root: { dir: string; cleanup: () => void };
  let repo: { repo: string; cleanup: () => void };
  let daemon: TestDaemon;
  let app: ReturnType<typeof createHttpApp>;
  let linear: ReturnType<typeof fakeLinear>;
  const HOST = { host: "127.0.0.1:4777" };
  const AUTH = { ...HOST, authorization: `Bearer ${TEST_TOKEN}` };
  const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

  beforeEach(async () => {
    root = tempDir();
    repo = createTempRepo();
    linear = linearFor();
    daemon = await createTestDaemon({ root: root.dir, repos: [repo.repo], mockEngines: true, linearFetch: linear.fetch });
    daemon.ctx.port = 4777;
    app = createHttpApp(daemon.ctx);
  });
  afterEach(async () => {
    await daemon.close();
    repo.cleanup();
    root.cleanup();
  });

  const keyFile = () => linearKeyPath(daemon.ctx.paths);

  it("requires authentication", async () => {
    expect((await app.request("/api/linear", { headers: HOST })).status).toBe(401);
    expect((await app.request("/api/linear/issues?q=x", { headers: HOST })).status).toBe(401);
  });

  it("connects with a valid key, never returns it, searches and disconnects", async () => {
    expect(await (await app.request("/api/linear", { headers: AUTH })).json()).toEqual({ connected: false, viewer: null, workspace: null, error: null });
    const notConnected = await app.request("/api/linear/issues?q=", { headers: AUTH });
    expect(notConnected.status).toBe(409);
    expect(((await notConnected.json()) as { code: string }).code).toBe(LINEAR_ERROR.notConnected);

    const put = await app.request("/api/linear/key", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ apiKey: ` ${KEY} ` }) });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ connected: true, workspace: { name: "Acme" } });
    expect(fs.readFileSync(keyFile(), "utf8").trim()).toBe(KEY);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);

    const status = await app.request("/api/linear", { headers: AUTH });
    expect(await status.text()).not.toContain(KEY);

    const found = await app.request(`/api/linear/issues?q=${encodeURIComponent("ENG-123")}`, { headers: AUTH });
    expect(await found.json()).toEqual({ issues: [ISSUE] });

    const del = await app.request("/api/linear/key", { method: "DELETE", headers: AUTH });
    expect(await del.json()).toMatchObject({ connected: false });
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("refuses a key Linear rejects with 422 and saves nothing", async () => {
    const res = await app.request("/api/linear/key", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ apiKey: "lin_api_wrong" }) });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ code: LINEAR_ERROR.keyInvalid });
    expect(body).not.toContain("lin_api_wrong");
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("passes the state filter to Linear and refuses unknown state types", async () => {
    writeLinearKey(daemon.ctx.paths, KEY);
    const ok = await app.request("/api/linear/issues?q=linear&states=completed,canceled", { headers: AUTH });
    expect(ok.status).toBe(200);
    expect(linear.calls.at(-1)!.variables).toMatchObject({ term: "linear", states: ["completed", "canceled"] });
    await app.request("/api/linear/issues?q=linear", { headers: AUTH });
    expect(linear.calls.at(-1)!.variables.states).toEqual(["triage", "backlog", "unstarted", "started"]);
    await app.request("/api/linear/issues?q=&scope=all", { headers: AUTH });
    expect(linear.calls.at(-1)!.query).toContain("issues(first: $first, orderBy: updatedAt");
    expect((await app.request("/api/linear/issues?q=&scope=team", { headers: AUTH })).status).toBe(400);
    const bad = await app.request("/api/linear/issues?q=linear&states=done", { headers: AUTH });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("Unknown Linear state type: done");
  });

  it("serves linked issues' states and validates the ids", async () => {
    writeLinearKey(daemon.ctx.paths, KEY);
    const ok = await app.request(`/api/linear/issue-states?ids=${ISSUE.id},unknown-id`, { headers: AUTH });
    expect(await ok.json()).toEqual({ issues: [ISSUE] });
    expect((await app.request("/api/linear/issue-states?ids=", { headers: AUTH })).status).toBe(400);
    expect((await app.request("/api/linear/issue-states?ids=a%20b", { headers: AUTH })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `id-${i}`).join(",");
    expect((await app.request(`/api/linear/issue-states?ids=${many}`, { headers: AUTH })).status).toBe(400);
  });

  it("answers 502 when Linear rejects the saved key or cannot be reached", async () => {
    writeLinearKey(daemon.ctx.paths, "lin_api_revoked");
    const rejected = await app.request("/api/linear/issues?q=x", { headers: AUTH });
    expect(rejected.status).toBe(502);
    expect(((await rejected.json()) as { code: string }).code).toBe(LINEAR_ERROR.keyInvalid);
    expect(await (await app.request("/api/linear", { headers: AUTH })).json()).toMatchObject({ connected: true, error: LINEAR_ERROR.keyInvalid });
  });

  it("lists a linked graph's issues with the graph", async () => {
    const graph = createEmptyGraph("eng-123", "ENG-123 Add Linear issues", "main", [ISSUE]);
    const dir = graphsDir((await daemon.repo(daemon.repoIds[0]!)).repo.path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "eng-123.json"), JSON.stringify(graph));
    const res = await app.request(`/api/repos/${daemon.repoIds[0]}/graphs`, { headers: AUTH });
    const { graphs } = (await res.json()) as { graphs: Array<{ id: string; issues?: unknown }> };
    expect(graphs.find((g) => g.id === "eng-123")?.issues).toEqual([{ id: ISSUE.id, identifier: "ENG-123", title: ISSUE.title, url: ISSUE.url }]);
  });
});
