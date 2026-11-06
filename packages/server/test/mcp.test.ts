import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_NAMES, ServerInfoSchema, validateGraph } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/cli/server.js";
import { getPaths } from "../src/config/paths.js";
import { readServerInfo, serverInfoPath } from "../src/config/server-info.js";
import type { McpEnvironment } from "../src/mcp/connection.js";
import { GraphDraftError, LAYOUT_DY, normalizeGraphDraft } from "../src/mcp/draft.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createTempRepo, fakeClaudeEnv, tempDir, waitFor } from "./helpers.js";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Absolute tsx loader: the background server is spawned with the temp repo as cwd. */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

describe("normalizeGraphDraft", () => {
  it("names edges, lays out nodes without a position and fills defaults", () => {
    const graph = normalizeGraphDraft({
      id: "draft",
      name: "Draft",
      nodes: [
        { id: "a", type: "prompt", label: "A", config: { prompt: "do a" } },
        { id: "b", type: "prompt", label: "B", config: { prompt: "do b" } },
        { id: "c", type: "prompt", label: "C", config: { prompt: "do c" } },
        { id: "m", type: "merge", label: "Merge" },
        { id: "fixed", type: "shell", label: "Fixed", position: { x: 5, y: 7 }, config: { run: "true" } },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "m" },
        { source: "c", target: "m" },
        { id: "e-a-b", source: "m", target: "fixed" },
      ],
    });
    expect(graph.version).toBe(1);
    expect(graph.settings.baseBranch).toBe("main");
    const ids = graph.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("e-a-b-2"); // collides with the explicit "e-a-b"
    const pos = Object.fromEntries(graph.nodes.map((n) => [n.id, n.position]));
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b!.y).toBe(LAYOUT_DY);
    expect(pos.c!.y).toBe(LAYOUT_DY);
    expect(pos.b!.x).not.toBe(pos.c!.x);
    expect(pos.m!.y).toBe(2 * LAYOUT_DY);
    expect(pos.fixed).toEqual({ x: 5, y: 7 });
  });

  it("ignores loop edges for the layout and relayouts everything with layout=all", () => {
    const graph = normalizeGraphDraft(
      {
        id: "loop",
        name: "Loop",
        nodes: [
          { id: "t", type: "shell", position: { x: 999, y: 999 }, config: { run: "npm test" } },
          { id: "fix", type: "prompt", config: { prompt: "fix" } },
        ],
        edges: [
          { source: "t", target: "fix" },
          { source: "fix", target: "t", loop: { maxIterations: 2 } },
        ],
      },
      { layout: "all" },
    );
    expect(graph.nodes.map((n) => n.position)).toEqual([{ x: 0, y: 0 }, { x: 0, y: LAYOUT_DY }]);
  });

  it("reports schema issues with their path", () => {
    expect(() => normalizeGraphDraft({ id: "Bad Id", name: "x", nodes: [{ id: "a", type: "nope" }] })).toThrow(GraphDraftError);
    expect(() => normalizeGraphDraft({ id: "Bad Id", name: "x", nodes: [] })).toThrow(/id/);
  });
});

describe("plugin skill patterns", () => {
  it("every complete graph in design-graph/references/patterns.md saves and validates without errors", () => {
    const file = path.resolve(SERVER_SRC, "../../plugins/promptgraph/skills/design-graph/references/patterns.md");
    const blocks = [...fs.readFileSync(file, "utf8").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
    const graphs = blocks.filter((b) => "nodes" in b);
    expect(graphs.length).toBeGreaterThanOrEqual(4);
    for (const raw of graphs) {
      const result = validateGraph(normalizeGraphDraft(raw), { phase: 2 });
      expect(result.errors, String(raw.id)).toEqual([]);
    }
  });
});

describe("server-info record", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it("is written (0600) once listening and removed on close", async () => {
    const { repo, cleanup } = createTempRepo();
    cleanups.push(cleanup);
    const { dir, cleanup: cleanRoot } = tempDir();
    cleanups.push(cleanRoot);
    const env = { ...process.env, ...fakeClaudeEnv(dir) };
    const paths = getPaths(env);
    const server = await startServer({ repoPath: repo, port: 0, env });
    const file = serverInfoPath(paths, repo);
    const info = ServerInfoSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    expect(info).toMatchObject({ pid: process.pid, repoPath: repo, port: server.port, token: server.token });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readServerInfo(paths, repo)).toEqual(info);
    await server.close();
    expect(fs.existsSync(file)).toBe(false);
    expect(readServerInfo(paths, repo)).toBeNull();
  });
});

describe("promptgraph MCP server", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function setup() {
    const { repo, cleanup } = createTempRepo("pg-mcp-repo-");
    cleanups.push(cleanup);
    const { dir, cleanup: cleanRoot } = tempDir("pg-mcp-");
    cleanups.push(cleanRoot);
    const env = { ...process.env, ...fakeClaudeEnv(dir) };
    delete env.PROMPTGRAPH_REPO;
    const opened: string[] = [];
    const mcpEnv: McpEnvironment = {
      cwd: repo,
      env,
      paths: getPaths(env),
      serverCommand: { command: process.execPath, args: ["--conditions=source", "--import", TSX, path.join(SERVER_SRC, "src/cli/index.ts")] },
    };
    const mcp = createMcpServer({ mcpEnv, openUrl: async (url) => void opened.push(url), pollMs: 50 });
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
        // plain-text result (errors, the markdown reference)
      }
      return { isError: res.isError === true, data, text };
    };
    return { repo, env, client, call, opened };
  }

  it("the setup guide lists exactly the registered tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it("lists its tools and explains when no server is running", async () => {
    const { client, call, repo } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["server_status", "start_server", "save_graph", "start_run", "wait_for_run", "get_run_report", "get_approval"]),
    );
    // Approvals stay a human action in the UI (invariant 4).
    expect(tools.map((t) => t.name).some((n) => /approve/.test(n))).toBe(false);
    expect((await call("server_status")).data).toMatchObject({ running: false, repoPath: repo });
    const res = await call("list_graphs");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("start_server");
    expect((await call("graph_reference")).text).toContain("# promptgraph graph format");
  });

  it("saves, validates, runs and reports a graph against a live server", { timeout: 30_000 }, async () => {
    const { repo, env, call, opened } = await setup();
    const server = await startServer({ repoPath: repo, port: 0, env });
    cleanups.push(() => server.close());

    expect((await call("server_status")).data).toMatchObject({ running: true, repo: { path: repo } });

    const invalid = await call("save_graph", { graph: { id: "broken", name: "Broken", nodes: [{ id: "m", type: "merge" }] } });
    expect(invalid.data).toMatchObject({ saved: true, runnable: false });
    expect(invalid.data.validation.errors.map((e: { code: string }) => e.code)).toContain("merge_input_count");
    const refused = await call("start_run", { graphId: "broken" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("validation_failed");

    const saved = await call("save_graph", {
      graph: {
        id: "hello",
        name: "Hello",
        nodes: [
          { id: "write", type: "shell", label: "Write", config: { run: "echo hi > hello.txt && echo wrote" } },
          { id: "check", type: "shell", label: "Check", config: { run: "cat hello.txt" } },
        ],
        edges: [{ source: "write", target: "check" }],
      },
    });
    expect(saved.data).toMatchObject({ saved: true, graphId: "hello", runnable: true });
    expect(fs.existsSync(path.join(repo, ".promptgraph/graphs/hello.json"))).toBe(true);
    expect((await call("list_graphs")).data.map((g: { id: string }) => g.id)).toEqual(["broken", "hello"]);

    const started = await call("start_run", { graphId: "hello" });
    expect(started.isError).toBe(false);
    const runId = started.data.runId as string;
    const done = await call("wait_for_run", { runId, until: "finished", timeoutSec: 20 });
    expect(done.data).toMatchObject({ runId, status: "succeeded", timedOut: false });
    expect(done.data.steps.map((s: { nodeId: string; status: string }) => [s.nodeId, s.status])).toEqual([
      ["write", "succeeded"],
      ["check", "succeeded"],
    ]);

    const output = await call("get_node_output", { runId, nodeId: "check" });
    expect(output.data.output.stdoutTail).toContain("hi");
    expect(output.data.attempts).toHaveLength(1);

    const report = await call("get_run_report", { runId });
    expect(report.data).toMatchObject({ runId, status: "succeeded" });
    expect(report.data.steps).toHaveLength(2);

    const diff = await call("get_diff", { nodeRunId: output.data.attempts[0].nodeRunId, scope: "lane" });
    expect(diff.isError).toBe(false);

    expect((await call("list_runs", { graphId: "hello" })).data[0]).toMatchObject({ runId, status: "succeeded" });

    const ui = await call("open_ui");
    expect(ui.data).toMatchObject({ opened: true });
    expect(ui.text).not.toContain(server.token);
    expect(opened).toEqual([`http://127.0.0.1:${server.port}/?t=${encodeURIComponent(server.token)}`]);
  });

  it("start_server launches promptgraph in the background and is a no-op once it runs", { timeout: 40_000 }, async () => {
    const { repo, env, call } = await setup();
    const first = await call("start_server");
    expect(first.isError, first.text).toBe(false);
    expect(first.data).toMatchObject({ started: true, repoPath: repo });
    const pid = first.data.pid as number;
    cleanups.push(async () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
      await waitFor(() => !readServerInfo(getPaths(env), repo), 10_000, 100).catch(() => {});
    });
    expect(pid).not.toBe(process.pid);
    expect((await call("server_status")).data).toMatchObject({ running: true, pid });
    expect((await call("start_server")).data).toMatchObject({ started: false, pid });
  });
});
