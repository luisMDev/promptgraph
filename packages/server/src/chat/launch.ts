import fs from "node:fs";
import path from "node:path";
import { PROMPTGRAPH_MCP_TOOL_PREFIXES } from "@promptgraph/shared";
import { shellQuote } from "../mcp/setup.js";

/**
 * How the chat's Claude Code process is started (DESIGN §20.2): the system prompt, the pre-allowed
 * tools, how the promptgraph MCP server is connected and the argument list.
 */

export const CHAT_SYSTEM_PROMPT = `You are running inside promptgraph's chat panel, next to the graph canvas. promptgraph is a local tool where each graph node is a step (a Claude Code prompt, a slash command, a shell command, a commit, a PR, an approval, a merge) and a run executes the graph.

- The user sees the graph live: every change you save appears on the canvas immediately.
- Each user message starts with a <promptgraph-context /> block: "graph" is the id of the graph on screen ("none" when no graph is open), "selected-nodes" and "selected-edges" are the current selection ("this node", "these steps" mean the selection), "run" is the run on screen and "read-only" says whether the graph can be edited now (a run is active or a historical run is shown). The user does not see this block; do not mention it.
- Use the promptgraph MCP tools: graph_reference for the format, list_graphs and get_graph to read, save_graph to create a new graph, patch_graph to edit an existing graph (keep node ids and positions; change only what was asked), validate_graph to check a graph. Use the design-graph skill when designing a graph. Read repository files (Read, Grep, Glob, LS) to ground the design in the real code.
- Never call start_server or open_ui: the server and the UI are already running.
- Never approve gates; approvals happen in the UI.
- Ask before destructive tools (delete_graph, cancel_run, cleanup_run).
- Do not edit repository files or run commands unless the user explicitly asks you to: the real work happens in graph runs.
- When you need an answer from the user, ask in your reply text and stop: the panel has no question dialog.
- Keep replies short and say what changed in the graph.`;

/**
 * Built-in tools the chat process cannot use. AskUserQuestion needs the interactive TUI: in stream-json
 * mode it arrives as a permission prompt the panel cannot answer (seen in the smoke test), so the
 * system prompt tells Claude to ask in plain text instead.
 */
export const CHAT_DISALLOWED_TOOLS = ["AskUserQuestion"] as const;

/**
 * promptgraph MCP tools allowed without a prompt. Not here: delete_graph, cancel_run, cleanup_run
 * (destructive), start_run / resume_run / node_action (start or change real work) and start_server /
 * open_ui (never needed inside the app), so those go through the permission card.
 */
export const CHAT_PREALLOWED_MCP_TOOLS = [
  "server_status",
  "graph_reference",
  "list_graphs",
  "get_graph",
  "save_graph",
  "patch_graph",
  "validate_graph",
  "list_commands",
  "list_runs",
  "get_run",
  "wait_for_run",
  "get_node_output",
  "get_diff",
  "get_run_report",
  "list_pending",
  "get_approval",
] as const;

/**
 * Tool names for --allowedTools: the pre-allowed promptgraph MCP tools by full name for the given prefix.
 * No built-in read tools: in --permission-mode default Claude Code already reads inside the cwd (the repo)
 * without asking, and a bare `Read` / `Grep` / `Glob` / `LS` rule would also silence the prompt for paths
 * outside it (~/.ssh, ~/.promptgraph, other repos).
 */
export function chatAllowedTools(mcpToolPrefix: string): string[] {
  return CHAT_PREALLOWED_MCP_TOOLS.map((t) => `${mcpToolPrefix}${t}`);
}

/** How the promptgraph MCP server reaches the chat process. */
export interface ChatMcpLaunch {
  /** --plugin-dir (MCP server + skills), or null for the --mcp-config fallback. */
  pluginDir: string | null;
  /** Inline JSON for --mcp-config when there is no plugin dir. */
  mcpConfig: string | null;
  /** Prefix of the promptgraph MCP tool names in this setup. */
  toolPrefix: string;
  /** Extra env for the claude process (PROMPTGRAPH_REPO, PROMPTGRAPH_BIN). */
  env: Record<string, string>;
  /** Shown in chat:status (e.g. no skills in the fallback). */
  warning?: string;
}

export interface ResolveChatMcpInput {
  repoPath: string;
  /** Entry of the running promptgraph CLI (currentCliEntry()). */
  cliEntry: string;
  /** Node binary running the CLI (process.execPath). */
  nodePath: string;
  /** Node flags of the running process (process.execArgv); only used for a TypeScript entry (dev, tsx). */
  execArgv?: readonly string[];
  /** Checkout that bundles the plugin (bundledMarketplaceRoot()), or null. */
  marketplaceRoot: string | null;
  /** Where a launcher script may be written (PgPaths.binDir). */
  binDir: string;
}

const LAUNCHER_NAME = "promptgraph-mcp";
/** Debugger / watch flags must not be inherited by the MCP server. */
const DROPPED_FLAGS = /^--(inspect|inspect-brk|inspect-port|watch|watch-path|watch-preserve-output)(=|$)/;

/**
 * Plugin dir and PROMPTGRAPH_BIN like the setup wizard derives them (§19.5): the plugin bundled next to
 * this server (`<checkout>/plugins/promptgraph`), and the CLI that runs this server. The plugin's
 * .mcp.json runs `${PROMPTGRAPH_BIN:-promptgraph} mcp`, so PROMPTGRAPH_BIN must be one executable: the
 * built CLI when it is executable, else a small launcher script in binDir (`node [flags] <entry> "$@"`,
 * e.g. in dev where the entry is src/cli/index.ts run by tsx). Without a plugin dir, --mcp-config
 * registers the server directly (tools only, no skills; reported as a warning).
 */
export function resolveChatMcp(input: ResolveChatMcpInput): ChatMcpLaunch {
  const nodeArgs = nodeArgsFor(input);
  const env: Record<string, string> = { PROMPTGRAPH_REPO: input.repoPath };
  const pluginDir = input.marketplaceRoot ? path.join(input.marketplaceRoot, "plugins", "promptgraph") : null;
  if (pluginDir && fs.existsSync(path.join(pluginDir, ".mcp.json"))) {
    env.PROMPTGRAPH_BIN = isExecutableScript(input.cliEntry) ? input.cliEntry : writeLauncher(input.binDir, input.nodePath, nodeArgs);
    return { pluginDir, mcpConfig: null, toolPrefix: PROMPTGRAPH_MCP_TOOL_PREFIXES[0], env };
  }
  const mcpConfig = JSON.stringify({
    mcpServers: { promptgraph: { command: input.nodePath, args: [...nodeArgs, "mcp"], env: { PROMPTGRAPH_REPO: input.repoPath } } },
  });
  return {
    pluginDir: null,
    mcpConfig,
    toolPrefix: PROMPTGRAPH_MCP_TOOL_PREFIXES[1],
    env,
    warning: "The promptgraph plugin is not bundled with this server: graph tools are connected, but the design-graph skill is not",
  };
}

/** Node arguments that start the CLI: [flags…, entry]. */
function nodeArgsFor(input: ResolveChatMcpInput): string[] {
  const flags = /\.[cm]?ts$/.test(input.cliEntry) ? (input.execArgv ?? []).filter((f) => !DROPPED_FLAGS.test(f)) : [];
  return [...flags, input.cliEntry];
}

function isExecutableScript(file: string): boolean {
  if (!/\.[cm]?js$/.test(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function writeLauncher(binDir: string, nodePath: string, nodeArgs: readonly string[]): string {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, LAUNCHER_NAME);
  const script = `#!/bin/sh\nexec ${[nodePath, ...nodeArgs].map(shellQuote).join(" ")} "$@"\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  fs.renameSync(tmp, file);
  return file;
}

export interface ChatArgsInput {
  sessionId: string;
  /** --resume <sessionId> instead of --session-id (Claude Code already has the session). */
  resume: boolean;
  title: string;
  mcp: Pick<ChatMcpLaunch, "pluginDir" | "mcpConfig" | "toolPrefix">;
  model?: string | null;
  systemPrompt?: string;
}

/** `claude` arguments for a chat process (DESIGN §20.2). Never bypassPermissions (invariant 5). */
export function buildChatArgs(input: ChatArgsInput): string[] {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
  args.push("--name", `pg:chat/${input.title}`);
  args.push("--permission-mode", "default", "--permission-prompt-tool", "stdio");
  if (input.mcp.pluginDir) args.push("--plugin-dir", input.mcp.pluginDir);
  else if (input.mcp.mcpConfig) args.push("--mcp-config", input.mcp.mcpConfig);
  args.push("--append-system-prompt", input.systemPrompt ?? CHAT_SYSTEM_PROMPT);
  args.push("--disallowedTools", ...CHAT_DISALLOWED_TOOLS);
  // Variadic flag: keep it last before --model so nothing else is taken as a tool name.
  args.push("--allowedTools", ...chatAllowedTools(input.mcp.toolPrefix));
  if (input.model) args.push("--model", input.model);
  return args;
}
