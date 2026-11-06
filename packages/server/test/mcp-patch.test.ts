import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { API, GraphSchema, type Graph, type RepoSummary } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/config/paths.js";
import { startDaemon } from "../src/daemon/start.js";
import type { McpEnvironment } from "../src/mcp/connection.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createTempRepo, fakeClaudeEnv, tempDir } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const GRAPH = {
  version: 1,
  id: "flow",
  name: "Flow",
  settings: { baseBranch: "main" },
  nodes: [
    { id: "impl", type: "prompt", label: "Implement", position: { x: 0, y: 0 }, config: { prompt: "Implement it" } },
    { id: "lint", type: "shell", label: "Lint", position: { x: 300, y: 0 }, config: { run: "npm run lint" } },
    { id: "test", type: "shell", label: "Test", position: { x: 600, y: 0 }, config: { run: "npm test" } },
  ],
  edges: [
    { id: "e-impl-lint", source: "impl", target: "lint" },
    { id: "e-lint-test", source: "lint", target: "test" },
  ],
};

/**
 * MCP client ↔ promptgraph MCP server in memory, against a live promptgraph daemon (fake claude) with the
 * repository registered.
 * `beforeFetch` runs before each REST call the MCP tools make (to simulate concurrent edits).
 * `cwdOutsideRepo` starts the MCP server outside the repo with PROMPTGRAPH_REPO set.
 */
async function setup(opts: { beforeFetch?: (url: string, init?: RequestInit) => Promise<void>; cwdOutsideRepo?: boolean } = {}) {
  const { repo, cleanup } = createTempRepo("pg-mcp-patch-repo-");
  cleanups.push(cleanup);
  const { dir, cleanup: cleanRoot } = tempDir("pg-mcp-patch-");
  cleanups.push(cleanRoot);
  const env: NodeJS.ProcessEnv = { ...process.env, ...fakeClaudeEnv(dir), PG_DAEMON_SHELL_ENV: "0" };
  delete env.PROMPTGRAPH_REPO;
  const server = await startDaemon({ port: 0, env });
  cleanups.push(() => server.close());

  let cwd = repo;
  if (opts.cwdOutsideRepo) {
    // Like the chat child: the MCP server may start anywhere, PROMPTGRAPH_REPO names the repository.
    cwd = path.join(dir, "elsewhere");
    fs.mkdirSync(cwd);
    env.PROMPTGRAPH_REPO = repo;
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    await opts.beforeFetch?.(String(input), init);
    return fetch(input, init);
  };
  const mcpEnv: McpEnvironment = { cwd, env, paths: getPaths(env), serverCommand: [], fetchImpl };
  const mcp = createMcpServer({ mcpEnv, openUrl: async () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(() => client.close());

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain-text result (errors)
    }
    return { isError: res.isError === true, data, text };
  };
  const rest = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${server.origin}${p}`, {
      method,
      headers: { authorization: `Bearer ${server.ctx.getToken()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as T;
  };
  const readGraph = (): Graph => GraphSchema.parse(JSON.parse(fs.readFileSync(path.join(repo, ".promptgraph/graphs/flow.json"), "utf8")));
  const { id: repoId } = await rest<RepoSummary>("POST", API.repos, { path: repo });
  const repoApi = API.repo(repoId);
  await rest("PUT", repoApi.graph("flow"), GRAPH);
  return { repo, repoId, repoApi, server, client, call, rest, readGraph };
}

describe("patch_graph MCP tool", () => {
  it("is registered as a non-destructive write tool", { timeout: 20_000 }, async () => {
    const { client } = await setup();
    const tool = (await client.listTools()).tools.find((t) => t.name === "patch_graph");
    expect(tool).toBeDefined();
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(JSON.stringify(tool!.inputSchema)).toContain("insert_after");
  });

  it("applies ops to the saved graph, keeps ids and positions, and reports what changed", { timeout: 20_000 }, async () => {
    const { call, readGraph } = await setup();
    const res = await call("patch_graph", {
      graphId: "flow",
      ops: [
        { op: "remove_node", id: "lint" },
        { op: "insert_after", after: "test", node: { type: "commit", label: "Commit" } },
        { op: "update_node", id: "impl", label: "Build it", config: { prompt: "Build the landing page" } },
      ],
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.data).toMatchObject({ saved: true, graphId: "flow", removed: ["lint"], runnable: true });
    expect(res.data.added).toEqual([{ id: "commit", type: "commit", label: "Commit" }]);
    expect(res.data.updated).toEqual([expect.objectContaining({ id: "impl", label: "Build it" })]);
    expect(res.data.validation.errors).toEqual([]);

    const g = readGraph();
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["commit", "impl", "test"]);
    expect(g.nodes.find((n) => n.id === "impl")!.position).toEqual({ x: 0, y: 0 });
    expect(g.nodes.find((n) => n.id === "test")!.position).toEqual({ x: 600, y: 0 });
    expect(g.nodes.find((n) => n.id === "impl")!.config).toMatchObject({ prompt: "Build the landing page" });
    const pairs = g.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toEqual(["impl->test", "test->commit"]);
  });

  it("save_graph refuses to unlock PRs without approval, but keeps an unlock the user already set", { timeout: 20_000 }, async () => {
    const { call, rest, readGraph, repoApi } = await setup();
    const unlocked = { ...GRAPH, settings: { ...GRAPH.settings, allowPrWithoutApproval: true } };
    const res = await call("save_graph", { graph: unlocked });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("allowPrWithoutApproval");
    expect(readGraph().settings.allowPrWithoutApproval).toBeFalsy();

    // Unlocked by the user (REST, like the UI): Claude may save the graph again with the setting kept.
    await rest("PUT", repoApi.graph("flow"), unlocked);
    const again = await call("save_graph", { graph: { ...unlocked, name: "Flow 2" } });
    expect(again.isError, again.text).toBe(false);
    expect(readGraph().settings.allowPrWithoutApproval).toBe(true);
  });

  it("reports invalid ops without saving anything", { timeout: 20_000 }, async () => {
    const { call, readGraph } = await setup();
    const before = readGraph();
    const res = await call("patch_graph", { graphId: "flow", ops: [{ op: "remove_node", id: "nope" }] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("unknown_node");
    expect(res.text).toContain("Nothing was saved");
    expect(readGraph()).toEqual(before);

    const malformed = await call("patch_graph", { graphId: "flow", ops: [{ op: "explode" }] });
    expect(malformed.isError).toBe(true);
    expect(readGraph()).toEqual(before);
  });

  it("tells Claude to re-read and retry when the graph changed concurrently (409)", { timeout: 20_000 }, async () => {
    let edited = false;
    let rest: (<T>(method: string, p: string, body?: unknown) => Promise<T>) | undefined;
    let graphPath = "";
    const ctx = await setup({
      beforeFetch: async (_url, init) => {
        // The user saves from the editor between patch_graph's GET and its PUT.
        if (init?.method === "PUT" && !edited && rest) {
          edited = true;
          await rest("PUT", graphPath, { ...GRAPH, name: "Renamed in the UI" });
        }
      },
    });
    rest = ctx.rest;
    graphPath = ctx.repoApi.graph("flow");
    const res = await ctx.call("patch_graph", { graphId: "flow", ops: [{ op: "remove_node", id: "lint" }] });
    expect(edited).toBe(true);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/get_graph again/);
    const g = ctx.readGraph();
    expect(g.name).toBe("Renamed in the UI");
    expect(g.nodes.map((n) => n.id)).toContain("lint");
  });

  it("refuses while a run of the graph is active", { timeout: 20_000 }, async () => {
    const { call, server, repoId } = await setup();
    const { engine } = await server.ctx.registry.load(repoId);
    const original = engine.activeRunForGraph.bind(engine);
    engine.activeRunForGraph = (id: string) => (id === "flow" ? "run-1" : original(id));
    const res = await call("patch_graph", { graphId: "flow", ops: [{ op: "remove_node", id: "lint" }] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("read-only");
  });
});

describe("MCP server started by the chat child", () => {
  it("finds the repository through PROMPTGRAPH_REPO when its cwd is elsewhere", { timeout: 20_000 }, async () => {
    const { call, repo } = await setup({ cwdOutsideRepo: true });
    expect((await call("server_status")).data).toMatchObject({ running: true, repoPath: repo });
    expect((await call("list_graphs")).data.map((g: { id: string }) => g.id)).toEqual(["flow"]);
  });
});
