import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import open from "open";
import { getPaths } from "../config/paths.js";
import { VERSION } from "../config/version.js";
import type { McpEnvironment } from "./connection.js";
import { GRAPH_REFERENCE } from "./reference.js";
import { registerTools, type ToolDeps } from "./tools.js";

const MCP_INSTRUCTIONS = `promptgraph runs graphs of Claude Code steps (prompts, slash commands, shell, commit, PR, approval, merge, condition) on a local server, each parallel branch in its own git worktree.
Workflow: server_status → (start_server) → graph_reference → save_graph → start_run → wait_for_run → get_run_report.
To change an existing graph use patch_graph (small edits that keep ids and positions) instead of rewriting it with save_graph.
Approvals and pull-request gates are approved by the user in the UI (open_ui), never through these tools. Confirm with the user before cancel_run, cleanup_run or delete_graph.`;

/** The MCP server with every promptgraph tool and the graph reference resource (§19). */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "promptgraph", version: VERSION }, { instructions: MCP_INSTRUCTIONS });
  registerTools(server, deps);
  server.registerResource(
    "graph-reference",
    "promptgraph://graph-reference",
    { title: "promptgraph graph format", description: "Node types, edges, conditions, loops and validation rules.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GRAPH_REFERENCE }] }),
  );
  return server;
}

/**
 * `promptgraph mcp`: MCP server on stdio. stdout carries the protocol only, so nothing here logs to it.
 * Resolves when the transport closes.
 */
export async function runMcpStdio(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const mcpEnv: McpEnvironment = {
    cwd: opts.cwd ?? process.cwd(),
    env,
    paths: getPaths(env),
    // Re-run this same CLI (works from dist and from tsx in development).
    serverCommand: { command: process.execPath, args: [...process.execArgv, process.argv[1]!] },
  };
  const server = createMcpServer({
    mcpEnv,
    openUrl: async (url) => {
      await open(url);
    },
  });
  const transport = new StdioServerTransport();
  // When stdin ends, the process exits once calls in flight have answered (nothing else keeps it alive).
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
