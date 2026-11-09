import {
  ASK_USER_QUESTION_TOOL,
  PROMPTGRAPH_MCP_TOOL_PREFIXES,
  shortToolName,
  type ChatItem,
  type ChatItemOf,
  type ChatPermissionRequestItem,
} from "@promptgraph/shared";

/**
 * How the chat panel lays out a session's items (DESIGN §21.6): consecutive tool calls are folded into one
 * activity group, as in Claude's apps, with each call's result and permission answer attached to it; an
 * AskUserQuestion call becomes a question block. Pure, so it is tested without React.
 */

export type ToolCategory = "read" | "search" | "edit" | "shell" | "web" | "skill" | "agent" | "todo" | "graph_read" | "graph_write" | "run" | "other";

export interface ToolStep {
  use: ChatItemOf<"tool_use">;
  result?: ChatItemOf<"tool_result">;
  /** The user's answer to the permission prompt of this call, if one was asked. */
  permission?: ChatItemOf<"permission_resolved">;
}

export type ChatBlock =
  | { type: "item"; id: string; item: ChatItem }
  | { type: "tools"; id: string; steps: ToolStep[] }
  | { type: "question"; id: string; step: ToolStep };

/** Items that render nothing on their own: they never split a group of tool calls. */
function isSilent(item: ChatItem): boolean {
  return item.kind === "permission_request" || (item.kind === "result" && !item.isError);
}

export function buildChatBlocks(items: readonly ChatItem[]): ChatBlock[] {
  const results = new Map<string, ChatItemOf<"tool_result">>();
  const requests = new Map<string, ChatPermissionRequestItem>();
  const toolUseIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_result") results.set(item.toolUseId, item);
    else if (item.kind === "permission_request") requests.set(item.requestId, item);
    else if (item.kind === "tool_use") toolUseIds.add(item.toolUseId);
  }
  // Permission answers that belong to a shown tool call are drawn on that call.
  const permissions = new Map<string, ChatItemOf<"permission_resolved">>();
  for (const item of items) {
    if (item.kind !== "permission_resolved") continue;
    const toolUseId = requests.get(item.requestId)?.toolUseId;
    if (toolUseId && toolUseIds.has(toolUseId)) permissions.set(toolUseId, item);
  }

  const blocks: ChatBlock[] = [];
  let group: Extract<ChatBlock, { type: "tools" }> | null = null;
  for (const item of items) {
    if (isSilent(item)) continue;
    if (item.kind === "tool_result" && toolUseIds.has(item.toolUseId)) continue;
    if (item.kind === "permission_resolved") {
      const toolUseId = requests.get(item.requestId)?.toolUseId;
      if (toolUseId && permissions.get(toolUseId) === item) continue;
    }
    if (item.kind === "tool_use") {
      const step: ToolStep = {
        use: item,
        ...(results.has(item.toolUseId) ? { result: results.get(item.toolUseId)! } : {}),
        ...(permissions.has(item.toolUseId) ? { permission: permissions.get(item.toolUseId)! } : {}),
      };
      if (item.name === ASK_USER_QUESTION_TOOL) {
        group = null;
        blocks.push({ type: "question", id: item.id, step });
        continue;
      }
      if (!group) {
        group = { type: "tools", id: item.id, steps: [] };
        blocks.push(group);
      }
      group.steps.push(step);
      continue;
    }
    group = null;
    blocks.push({ type: "item", id: item.id, item });
  }
  return blocks;
}

export type StepStatus = "running" | "done" | "error" | "denied";

export function stepStatus(step: ToolStep): StepStatus {
  if (step.permission && !step.permission.allowed) return "denied";
  if (!step.result) return "running";
  return step.result.isError ? "error" : "done";
}

function isPromptgraphTool(name: string): boolean {
  return PROMPTGRAPH_MCP_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function graphIdOf(input: unknown): string | undefined {
  const graph = (input as { graph?: { id?: unknown } } | null)?.graph;
  return str(input, "graphId") ?? str(input, "id") ?? (typeof graph?.id === "string" ? graph.id : undefined);
}

const GRAPH_READ_TOOLS = new Set(["graph_reference", "list_graphs", "get_graph", "validate_graph", "list_commands", "server_status"]);
const GRAPH_WRITE_TOOLS = new Set(["save_graph", "patch_graph", "delete_graph"]);

export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case "Read":
    case "LS":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
      return "shell";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Skill":
      return "skill";
    case "Task":
    case "Agent":
      return "agent";
    case "TodoWrite":
      return "todo";
  }
  if (isPromptgraphTool(name)) {
    const short = shortToolName(name);
    if (GRAPH_READ_TOOLS.has(short)) return "graph_read";
    if (GRAPH_WRITE_TOOLS.has(short)) return "graph_write";
    return "run";
  }
  return "other";
}

/** One line for a step: friendlier than the server's summary for the promptgraph tools and skills. */
export function stepLabel(use: ChatItemOf<"tool_use">): string {
  if (use.name === "Skill") {
    const skill = str(use.input, "skill") ?? str(use.input, "command");
    return skill ? `Use the ${skill.replace(/^.*:/, "")} skill` : "Use a skill";
  }
  if (!isPromptgraphTool(use.name)) return use.summary || shortToolName(use.name);
  const short = shortToolName(use.name);
  const id = graphIdOf(use.input);
  const ops = (use.input as { ops?: unknown } | null)?.ops;
  const opCount = Array.isArray(ops) ? ` · ${ops.length} change${ops.length === 1 ? "" : "s"}` : "";
  switch (short) {
    case "graph_reference":
      return "Read the graph format";
    case "list_graphs":
      return "List the graphs";
    case "get_graph":
      return id ? `Read graph ${id}` : "Read the graph";
    case "validate_graph":
      return id ? `Validate graph ${id}` : "Validate the graph";
    case "save_graph":
      return id ? `Save graph ${id}` : "Save the graph";
    case "patch_graph":
      return `${id ? `Update graph ${id}` : "Update the graph"}${opCount}`;
    case "delete_graph":
      return id ? `Delete graph ${id}` : "Delete a graph";
    case "list_commands":
      return "List slash commands";
    case "server_status":
      return "Check the promptgraph server";
    default:
      return use.summary || short;
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** Phrase for the steps of one category, e.g. "read 3 files", "updated the graph". */
function categoryPhrase(category: ToolCategory, steps: ToolStep[]): string {
  const n = steps.length;
  switch (category) {
    case "read":
      return `read ${plural(n, "a file", "files")}`;
    case "search":
      return n === 1 ? "searched the code" : `ran ${n} code searches`;
    case "edit":
      return `edited ${plural(n, "a file", "files")}`;
    case "shell":
      return `ran ${plural(n, "a command", "commands")}`;
    case "web":
      return "searched the web";
    case "skill":
      return steps.map((s) => stepLabel(s.use).replace(/^Use/, "used")).join(", ");
    case "agent":
      return `ran ${plural(n, "an agent", "agents")}`;
    case "todo":
      return "updated the plan";
    case "graph_read":
      return "read the graph";
    case "graph_write": {
      const created = steps.some((s) => shortToolName(s.use.name) === "save_graph");
      return created ? "saved the graph" : "updated the graph";
    }
    case "run":
      return "checked the runs";
    case "other":
      return `used ${plural(n, "a tool", "tools")}`;
  }
}

/**
 * Title of a collapsed group. While a call runs: that call ("Read src/app.ts"); afterwards, what the group did in
 * order of first appearance ("Read 2 files, updated the graph").
 */
export function groupTitle(steps: readonly ToolStep[]): string {
  const running = steps.findLast((s) => stepStatus(s) === "running");
  if (running) return stepLabel(running.use);
  const byCategory = new Map<ToolCategory, ToolStep[]>();
  for (const step of steps) {
    const category = toolCategory(step.use.name);
    byCategory.set(category, [...(byCategory.get(category) ?? []), step]);
  }
  const text = [...byCategory].map(([category, s]) => categoryPhrase(category, s)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
