import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_NAMES, RepoSummarySchema, validateGraph } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { daemonLogPath, readDaemonInfo } from "../src/config/daemon-info.js";
import { getPaths } from "../src/config/paths.js";
import { VERSION } from "../src/config/version.js";
import { startDaemon } from "../src/daemon/start.js";
import { resolveRepo, type McpEnvironment } from "../src/mcp/connection.js";
import { GraphDraftError, LAYOUT_DY, normalizeGraphDraft } from "../src/mcp/draft.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createTempRepo, fakeClaudeEnv, stopDaemonOf, tempDir } from "./helpers.js";

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Absolute tsx loader: the detached daemon is spawned with PG_HOME as cwd. */
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

describe("resolveRepo (DESIGN §19.2)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
  });

  it("maps a lane worktree (under worktreesDir) to the repository it belongs to", async () => {
    const { repo, cleanup } = createTempRepo("pg-mcp-lane-repo-");
    cleanups.push(cleanup);
    const { dir, cleanup: cleanRoot } = tempDir("pg-mcp-lane-");
    cleanups.push(cleanRoot);
    const env: NodeJS.ProcessEnv = { PG_HOME: path.join(dir, "home") };
    const paths = getPaths(env);
    const lane = path.join(paths.worktreesDir, "r", "run-1", "main");
    fs.mkdirSync(path.dirname(lane), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "--detach", lane], { cwd: repo });
    fs.mkdirSync(path.join(lane, "sub"));
    const mcpEnv: McpEnvironment = { cwd: path.join(lane, "sub"), env, paths, serverCommand: [] };
    expect(await resolveRepo(mcpEnv)).toBe(fs.realpathSync(repo));
    // A linked worktree outside worktreesDir is a repository of its own.
    const own = path.join(dir, "own-worktree");
    execFileSync("git", ["worktree", "add", "-q", "--detach", own], { cwd: repo });
    expect(await resolveRepo({ ...mcpEnv, cwd: own })).toBe(fs.realpathSync(own));
  });
});

describe("promptgraph MCP server", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function setup(opts: { version?: string } = {}) {
    const { repo, cleanup } = createTempRepo("pg-mcp-repo-");
    cleanups.push(cleanup);
    const { dir, cleanup: cleanRoot } = tempDir("pg-mcp-");
    cleanups.push(cleanRoot);
    const env: NodeJS.ProcessEnv = { ...process.env, ...fakeClaudeEnv(dir), PG_DAEMON_SHELL_ENV: "0" };
    delete env.PROMPTGRAPH_REPO;
    const opened: string[] = [];
    const mcpEnv: McpEnvironment = {
      cwd: repo,
      env,
      paths: getPaths(env),
      serverCommand: [process.execPath, "--conditions=source", "--import", TSX, path.join(SERVER_SRC, "src/cli/index.ts")],
      version: opts.version,
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
    expect((await call("server_status")).data).toEqual({ running: false, repoPath: repo, registered: false, hint: expect.stringContaining("start_server") });
    const res = await call("list_graphs");
    expect(res.isError).toBe(true);
    expect(res.text).toBe("promptgraph is not running; call start_server");
    expect((await call("graph_reference")).text).toContain("# promptgraph graph format");
  });

  it("saves, validates, runs and reports a graph through /api/repos/<id> of a live daemon", { timeout: 30_000 }, async () => {
    const { repo, env, call, opened } = await setup();
    const daemon = await startDaemon({ port: 0, env });
    cleanups.push(() => daemon.close());
    const token = daemon.ctx.getToken();

    // server_status: {running, pid?, version?, port?, repoPath, repoId?, registered, status?, versionMismatch?} (+ hint).
    expect((await call("server_status")).data).toEqual({
      running: true,
      pid: process.pid,
      version: VERSION,
      port: daemon.port,
      repoPath: repo,
      registered: false,
      hint: expect.any(String),
    });

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

    const status = (await call("server_status")).data;
    expect(status).toEqual({
      running: true,
      pid: process.pid,
      version: VERSION,
      port: daemon.port,
      repoPath: repo,
      registered: true,
      repoId: expect.any(String),
      status: expect.objectContaining({ id: status.repoId, path: repo, active: true, runs: { running: 0, paused: 0 } }),
    });
    expect(RepoSummarySchema.safeParse(status.status).success).toBe(true);
    expect(daemon.ctx.registry.list().map((r) => r.id)).toEqual([status.repoId]);

    const ui = await call("open_ui");
    const url = `${daemon.origin}/r/${status.repoId}`;
    expect(ui.data).toEqual({ opened: true, url });
    expect(ui.text).not.toContain(token);
    expect(ui.text).not.toContain("code=");
    expect(ui.text).not.toContain("/login");
    // The browser got a one-time login URL for this repository, which signs it in once.
    expect(opened).toHaveLength(1);
    const login = new URL(opened[0]!);
    expect(`${login.origin}${login.pathname}`).toBe(`${daemon.origin}/login`);
    expect(login.searchParams.get("next")).toBe(`/r/${status.repoId}`);
    expect(opened[0]).toContain(`&next=%2Fr%2F${status.repoId}`);
    expect(opened[0]).not.toContain(token);
    const redeemed = await fetch(opened[0]!, { redirect: "manual" });
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe(`/r/${status.repoId}`);
    expect(redeemed.headers.get("set-cookie")).toMatch(/^pg_session=/);
    expect((await fetch(opened[0]!, { redirect: "manual" })).status).toBe(401);
  });

  it("re-registers a repository removed while the same daemon keeps running", async () => {
    const { repo, env, call } = await setup();
    const daemon = await startDaemon({ port: 0, env });
    cleanups.push(() => daemon.close());
    expect((await call("list_graphs")).data).toEqual([]);
    const [registered] = daemon.ctx.registry.list();
    expect(registered).toMatchObject({ path: repo });
    // Removed from the UI or another client: the MCP server still has its repoId cached.
    await daemon.ctx.registry.remove(registered!.id);
    expect(daemon.ctx.registry.list()).toEqual([]);
    const again = await call("list_graphs");
    expect(again).toMatchObject({ isError: false, data: [] });
    expect(daemon.ctx.registry.list()).toEqual([expect.objectContaining({ id: registered!.id, path: repo })]);
  });

  it("refuses an older daemon with the documented message", async () => {
    const { env, call, repo } = await setup({ version: "99.0.0-other" });
    const daemon = await startDaemon({ port: 0, env });
    cleanups.push(() => daemon.close());
    const message = `promptgraph ${VERSION} is running (this is 99.0.0-other); run promptgraph stop, then retry`;
    const res = await call("list_graphs");
    expect(res).toMatchObject({ isError: true, text: message });
    expect((await call("server_status")).data).toEqual({
      running: true,
      pid: process.pid,
      version: VERSION,
      port: daemon.port,
      repoPath: repo,
      registered: false,
      versionMismatch: message,
    });
    const started = await call("start_server");
    expect(started).toMatchObject({ isError: true, text: message });
    expect(daemon.ctx.registry.list()).toEqual([]);
  });

  it("an MCP server older than the daemon (after a handover) asks to reconnect (DESIGN §4.1 item 4)", async () => {
    const { env, call, repo } = await setup({ version: "0.0.1" });
    const daemon = await startDaemon({ port: 0, env });
    cleanups.push(() => daemon.close());
    const message = `promptgraph was updated to ${VERSION} while this MCP server still runs 0.0.1; run /mcp in Claude Code and reconnect promptgraph (or restart Claude Code)`;
    for (const tool of ["list_graphs", "list_runs", "start_server", "open_ui"]) {
      expect(await call(tool), tool).toMatchObject({ isError: true, text: message });
    }
    expect((await call("server_status")).data).toEqual({
      running: true,
      pid: process.pid,
      version: VERSION,
      port: daemon.port,
      repoPath: repo,
      registered: false,
      versionMismatch: message,
    });
    expect(daemon.ctx.registry.list()).toEqual([]);
  });

  it("start_server spawns a detached daemon, registers the repository and is a no-op once it runs", { timeout: 40_000 }, async () => {
    const { repo, env, call } = await setup();
    const paths = getPaths(env);
    // Registered before the call and any assertion: a failure must not leave the detached daemon running.
    cleanups.push(() => stopDaemonOf(paths));
    const first = await call("start_server");
    expect(first.isError, first.text).toBe(false);
    expect(first.data).toMatchObject({ started: true, repoPath: repo, repoId: expect.any(String), logFile: daemonLogPath(paths) });
    const pid = first.data.pid as number;
    expect(pid).not.toBe(process.pid);
    expect(first.data.url).toBe(`http://127.0.0.1:${first.data.port}/r/${first.data.repoId}`);
    expect(readDaemonInfo(paths)?.pid).toBe(pid);
    expect(fs.readFileSync(daemonLogPath(paths), "utf8")).toContain("Listening: ");
    expect((await call("server_status")).data).toMatchObject({ running: true, pid, registered: true, repoId: first.data.repoId });
    expect((await call("start_server")).data).toMatchObject({ started: false, pid, repoId: first.data.repoId });
    expect((await call("list_graphs")).data).toEqual([]);
  });
});
