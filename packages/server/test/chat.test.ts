import fs from "node:fs";
import path from "node:path";
import { API, MCP_TOOL_GROUPS, MCP_TOOL_NAMES, type ChatContext, type ChatItem } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatError, ChatManager, chatTitle, type ChatManagerOptions } from "../src/chat/chat-manager.js";
import { buildChatArgs, CHAT_PREALLOWED_MCP_TOOLS, CHAT_SYSTEM_PROMPT, chatAllowedTools, resolveChatMcp, type ChatMcpLaunch } from "../src/chat/launch.js";
import { NdjsonParser } from "../src/chat/ndjson.js";
import { ChatNormalizer, summarizeToolUse, truncateToolResult } from "../src/chat/normalize.js";
import { permissionResponseLine, userTurnLine } from "../src/chat/protocol.js";
import { chatItemsFromTranscript, findChatTranscript, projectDirName } from "../src/chat/transcript.js";
import { EventBus, type ChatServerMessage } from "../src/events/bus.js";
import { createHttpApp } from "../src/http/app.js";
import { openDatabase, Store } from "../src/store/store.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { fakeSpawner, initLine, resultLine, streamEvent, textTurn, type FakeChatChild } from "./support/fake-chat-child.js";
import { createTestDaemon, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

const PLUGIN_PREFIX = "mcp__plugin_promptgraph_promptgraph__";
/** repoId stamped on every chat:* message of the managers under test. */
const REPO_ID = "my-repo-0123abcd";

const MCP: ChatMcpLaunch = {
  pluginDir: "/opt/pg/plugins/promptgraph",
  mcpConfig: null,
  toolPrefix: PLUGIN_PREFIX,
  env: { PROMPTGRAPH_REPO: "/repo", PROMPTGRAPH_BIN: "/opt/pg/dist/cli/index.js" },
};
const CONTEXT: ChatContext = { graphId: "landing", selectedNodeIds: ["n1", "n2"], selectedEdgeIds: [], runId: null, readOnly: false };

// --- args & launch -----------------------------------------------------------------------------

describe("buildChatArgs", () => {
  it("starts a new session with the plugin, stdio permissions and the pre-allowed tools", () => {
    const args = buildChatArgs({ sessionId: "abc", resume: false, title: "Landing page", mcp: MCP });
    expect(args.slice(0, 7)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--session-id")).toBe("abc");
    expect(args).not.toContain("--resume");
    expect(after("--name")).toBe("pg:chat/Landing page");
    expect(after("--permission-mode")).toBe("default");
    expect(after("--permission-prompt-tool")).toBe("stdio");
    expect(after("--plugin-dir")).toBe("/opt/pg/plugins/promptgraph");
    expect(args).not.toContain("--mcp-config");
    expect(after("--append-system-prompt")).toBe(CHAT_SYSTEM_PROMPT);
    expect(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--allowedTools"))).toEqual(["AskUserQuestion"]);
    expect(args).not.toContain("--model");
    expect(args.join(" ")).not.toMatch(/bypassPermissions|dangerously/);
    const tools = args.slice(args.indexOf("--allowedTools") + 1);
    expect(tools).toEqual(chatAllowedTools(PLUGIN_PREFIX));
    expect(tools).toEqual(expect.arrayContaining([`${PLUGIN_PREFIX}patch_graph`, `${PLUGIN_PREFIX}save_graph`]));
    // Bare built-in read rules would also allow reads outside the repo without a prompt.
    for (const t of ["Read", "Grep", "Glob", "LS"]) expect(tools.some((x) => x === t || x.startsWith(`${t}(`))).toBe(false);
    for (const t of ["delete_graph", "cancel_run", "cleanup_run", "start_server", "open_ui", "start_run"]) {
      expect(tools).not.toContain(`${PLUGIN_PREFIX}${t}`);
    }
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
  });

  it("resumes an existing session, uses --mcp-config without plugin and passes the model", () => {
    const args = buildChatArgs({
      sessionId: "abc",
      resume: true,
      title: "x",
      mcp: { pluginDir: null, mcpConfig: '{"mcpServers":{}}', toolPrefix: "mcp__promptgraph__" },
      model: "opus",
    });
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--plugin-dir");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
    expect(args).toContain("mcp__promptgraph__get_graph");
  });

  it("pre-allows only catalogued, non-destructive promptgraph tools", () => {
    const confirmFirst = MCP_TOOL_GROUPS.flatMap((g) => g.tools.filter((t) => t.confirmFirst).map((t) => t.name));
    for (const tool of CHAT_PREALLOWED_MCP_TOOLS) {
      expect(MCP_TOOL_NAMES).toContain(tool);
      expect(confirmFirst).not.toContain(tool);
    }
  });

  it("the system prompt covers the rules of the chat", () => {
    for (const s of ["<promptgraph-context", "patch_graph", "save_graph", "design-graph", "start_server", "open_ui", "approve"]) {
      expect(CHAT_SYSTEM_PROMPT).toContain(s);
    }
  });
});

describe("resolveChatMcp", () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  function checkout(): string {
    const root = path.join(dir, "checkout");
    fs.mkdirSync(path.join(root, "plugins", "promptgraph"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "promptgraph", ".mcp.json"), "{}");
    return root;
  }

  it("uses the bundled plugin and the executable built CLI as PROMPTGRAPH_BIN", () => {
    const root = checkout();
    const entry = path.join(dir, "dist", "cli", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o755 });
    const mcp = resolveChatMcp({ repoPath: "/repo", cliEntry: entry, nodePath: "/usr/bin/node", marketplaceRoot: root, binDir: path.join(dir, "bin") });
    expect(mcp.pluginDir).toBe(path.join(root, "plugins", "promptgraph"));
    expect(mcp.mcpConfig).toBeNull();
    expect(mcp.toolPrefix).toBe(PLUGIN_PREFIX);
    expect(mcp.env).toEqual({ PROMPTGRAPH_REPO: "/repo", PROMPTGRAPH_BIN: entry });
    expect(mcp.warning).toBeUndefined();
  });

  it("writes a launcher when the CLI entry is not executable (dev: TypeScript via tsx)", () => {
    const root = checkout();
    const binDir = path.join(dir, "bin");
    const mcp = resolveChatMcp({
      repoPath: "/repo",
      cliEntry: "/src/promptgraph/packages/server/src/cli/index.ts",
      nodePath: "/usr/bin/node",
      execArgv: ["--import", "file:///tsx/loader.mjs", "--inspect=9229", "--conditions=source"],
      marketplaceRoot: root,
      binDir,
    });
    const launcher = mcp.env.PROMPTGRAPH_BIN!;
    expect(launcher).toBe(path.join(binDir, "promptgraph-mcp"));
    expect(fs.statSync(launcher).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(launcher, "utf8")).toBe(
      `#!/bin/sh\nexec /usr/bin/node --import file:///tsx/loader.mjs --conditions=source /src/promptgraph/packages/server/src/cli/index.ts "$@"\n`,
    );
  });

  it("falls back to --mcp-config (no skills, warning) without a bundled plugin", () => {
    const entry = "/opt/pg/dist/cli/index.js";
    const mcp = resolveChatMcp({ repoPath: "/repo", cliEntry: entry, nodePath: "/usr/bin/node", marketplaceRoot: null, binDir: path.join(dir, "bin") });
    expect(mcp.pluginDir).toBeNull();
    expect(mcp.toolPrefix).toBe("mcp__promptgraph__");
    expect(JSON.parse(mcp.mcpConfig!)).toEqual({
      mcpServers: { promptgraph: { command: "/usr/bin/node", args: [entry, "mcp"], env: { PROMPTGRAPH_REPO: "/repo" } } },
    });
    expect(mcp.env).toEqual({ PROMPTGRAPH_REPO: "/repo" });
    expect(mcp.warning).toMatch(/skill/);
  });
});

// --- parsing -----------------------------------------------------------------------------------

describe("NdjsonParser", () => {
  it("joins lines split across chunks (also inside UTF-8 characters) and reports non-JSON lines", () => {
    const values: unknown[] = [];
    const invalid: string[] = [];
    const parser = new NdjsonParser((v) => values.push(v), (l) => invalid.push(l));
    const bytes = Buffer.from(`{"a":1}\n\nnot json\n{"t":"héllo ✓"}\n{"b"`);
    for (let i = 0; i < bytes.length; i += 3) parser.push(bytes.subarray(i, i + 3));
    parser.push(':2}\n{"c":3}');
    parser.flush();
    expect(values).toEqual([{ a: 1 }, { t: "héllo ✓" }, { b: 2 }, { c: 3 }]);
    expect(invalid).toEqual(["not json"]);
  });
});

describe("ChatNormalizer", () => {
  const make = () => {
    let n = 0;
    return new ChatNormalizer({ newId: () => `id${++n}`, now: () => 1000, cwd: "/repo" });
  };
  const all = (norm: ChatNormalizer, lines: unknown[]) => lines.flatMap((l) => norm.handle(l));

  it("streams text deltas under the messageId of the final assistant item", () => {
    const events = all(make(), textTurn("msg_1", ["Hel", "lo"]));
    expect(events.filter((e) => e.kind === "delta")).toEqual([
      { kind: "delta", messageId: "msg_1#0", text: "Hel" },
      { kind: "delta", messageId: "msg_1#0", text: "lo" },
    ]);
    expect(events.filter((e) => e.kind === "item")).toEqual([
      { kind: "item", item: { id: "id1", ts: 1000, kind: "assistant", messageId: "msg_1#0", text: "Hello" } },
    ]);
  });

  it("numbers text blocks only, so a text after a tool use gets #1 in both streams", () => {
    const norm = make();
    const events = all(norm, [
      streamEvent({ type: "message_start", message: { id: "m" } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "a" } }),
      streamEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use" } }),
      streamEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{" } }),
      streamEvent({ type: "content_block_start", index: 3, content_block: { type: "text" } }),
      streamEvent({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "b" } }),
      // Claude Code writes one assistant line per content block.
      { type: "assistant", message: { id: "m", content: [{ type: "thinking", thinking: "…" }] } },
      { type: "assistant", message: { id: "m", content: [{ type: "text", text: "a" }] } },
      { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/repo/src/app.ts" } }] } },
      { type: "assistant", message: { id: "m", content: [{ type: "text", text: "b" }] } },
    ]);
    const ids = events.map((e) => (e.kind === "delta" ? `d:${e.messageId}` : e.kind === "item" && e.item.kind === "assistant" ? `a:${e.item.messageId}` : null));
    expect(ids.filter(Boolean)).toEqual(["d:m#0", "d:m#1", "a:m#0", "a:m#1"]);
    const tool = events.find((e) => e.kind === "item" && e.item.kind === "tool_use");
    expect(tool).toMatchObject({ item: { kind: "tool_use", toolUseId: "tu1", name: "Read", summary: "Read src/app.ts" } });
  });

  it("turns tool results into items, truncated", () => {
    const long = "x".repeat(5000);
    const events = make().handle({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: long }] },
          { type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true },
        ],
      },
    });
    const items = events.map((e) => (e.kind === "item" ? e.item : null));
    expect(items[0]).toMatchObject({ kind: "tool_result", toolUseId: "tu1", isError: false });
    expect((items[0] as { text: string }).text.length).toBe(2000);
    expect((items[0] as { text: string }).text).toMatch(/truncated\]$/);
    expect(items[1]).toMatchObject({ kind: "tool_result", toolUseId: "tu2", isError: true, text: "boom" });
    expect(truncateToolResult("short")).toBe("short");
  });

  it("reports a failed promptgraph MCP server once, but not a pending one", () => {
    const failed = make();
    const events = all(failed, [initLine("s", "failed"), initLine("s", "failed")]);
    expect(events.filter((e) => e.kind === "init")).toHaveLength(2);
    const notices = events.filter((e) => e.kind === "item" && e.item.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ item: { text: expect.stringContaining("plugin:promptgraph:promptgraph failed to connect") } });
    expect(all(make(), [initLine("s", "pending")]).filter((e) => e.kind === "item")).toEqual([]);
    expect(all(make(), [initLine("s", "connected", "other")])[1]).toMatchObject({ item: { kind: "notice", text: expect.stringContaining("not loaded") } });
  });

  it("maps can_use_tool to a permission event and other control requests to unsupported", () => {
    const norm = make();
    expect(
      norm.handle({
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input: { command: "ls" }, description: "List", tool_use_id: "tu" },
      }),
    ).toEqual([
      {
        kind: "permission",
        item: { id: "id1", ts: 1000, kind: "permission_request", requestId: "req-1", toolName: "Bash", displayName: "Bash", input: { command: "ls" }, description: "List" },
      },
    ]);
    expect(norm.handle({ type: "control_request", request_id: "r2", request: { subtype: "hook_callback" } })).toEqual([
      { kind: "unsupported_control", requestId: "r2", subtype: "hook_callback" },
    ]);
  });

  it("ignores unknown and malformed lines", () => {
    const norm = make();
    for (const line of [null, 3, "x", {}, { type: "rate_limit_event" }, { type: "system", subtype: "status" }, { type: "assistant" }, { type: "result" }]) {
      expect(norm.handle(line)).toEqual([]);
    }
  });

  it("summarises tool uses", () => {
    expect(summarizeToolUse(`${PLUGIN_PREFIX}patch_graph`, { graphId: "landing", ops: [{}, {}] })).toBe("patch_graph landing · 2 ops");
    expect(summarizeToolUse(`${PLUGIN_PREFIX}save_graph`, { graph: { id: "g" } })).toBe("save_graph g");
    expect(summarizeToolUse("mcp__promptgraph__list_graphs", {})).toBe("list_graphs");
    expect(summarizeToolUse("mcp__github__get_issue", { id: "1" })).toBe("github/get_issue 1");
    expect(summarizeToolUse("Grep", { pattern: "foo", path: "/repo/src" }, "/repo")).toBe('Grep "foo" in src');
    expect(summarizeToolUse("Bash", { command: "pnpm  test\n--run" })).toBe("Bash: pnpm test --run");
    expect(summarizeToolUse("Read", { file_path: "/elsewhere/x.ts" }, "/repo")).toBe("Read /elsewhere/x.ts");
    expect(summarizeToolUse("Unknown", {})).toBe("Unknown");
    expect(summarizeToolUse("Bash", { command: "x".repeat(300) }).length).toBeLessThanOrEqual(120);
  });
});

describe("stdin lines", () => {
  it("encodes user turns and permission answers exactly", () => {
    expect(JSON.parse(userTurnLine("hi"))).toEqual({ type: "user", message: { role: "user", content: "hi" } });
    expect(permissionResponseLine("r", { allow: false, message: "no" })).toBe(
      '{"type":"control_response","response":{"subtype":"success","request_id":"r","response":{"behavior":"deny","message":"no"}}}',
    );
  });
});

// --- manager -----------------------------------------------------------------------------------

describe("ChatManager", () => {
  let dir: string;
  let cleanup: () => void;
  let store: Store;
  let bus: EventBus;
  let messages: ChatServerMessage[];
  let fake: ReturnType<typeof fakeSpawner>;
  let manager: ChatManager;
  let env: NodeJS.ProcessEnv;
  const repoPath = "/work/my repo";

  function makeManager(extra: Partial<ChatManagerOptions> = {}): ChatManager {
    return new ChatManager({ store, bus, repoId: REPO_ID, repoPath, env, mcp: () => MCP, spawner: fake.spawner, newSessionId: () => "sess-1", ...extra });
  }

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: path.join(dir, "claude"), PG_CLAUDE_BIN: "/fake/claude", CLAUDECODE: "1" };
    store = new Store(openDatabase(":memory:"));
    bus = new EventBus();
    messages = [];
    bus.on("chat", ({ message }) => messages.push(message));
    fake = fakeSpawner();
    manager = makeManager();
  });
  afterEach(() => {
    vi.useRealTimers();
    store.db.close();
    cleanup();
  });

  const items = (sessionId = "sess-1"): ChatItem[] => manager.get(sessionId)!.items;
  const kinds = () => items().map((i) => i.kind);
  const statuses = () => messages.filter((m) => m.type === "chat:status").map((m) => (m as { status: string }).status);
  const userContent = (child: FakeChatChild, i: number) => (child.writtenJson[i] as { message: { content: string } }).message.content;

  it("creates sessions in the store and lists them", () => {
    const s = manager.create({ model: "opus" });
    expect(s).toMatchObject({ id: "sess-1", title: "New chat", status: "idle", totalCostUsd: 0, model: "opus" });
    expect(messages).toEqual([{ type: "chat:session", repoId: REPO_ID, session: s }]);
    expect(manager.list()).toEqual([s]);
    expect(store.getChatSession("sess-1")).toMatchObject({ repoPath, model: "opus", title: null, started: false });
    expect(manager.get("nope")).toBeUndefined();
    expect(() => manager.send("nope", "x", CONTEXT)).toThrow(ChatError);
  });

  it("runs several turns on one process, streaming deltas, with the context block prepended", () => {
    manager.create();
    manager.send("sess-1", "Build a landing page", CONTEXT);
    expect(fake.children).toHaveLength(1);
    const child = fake.last();
    expect(child.spec.command).toBe("/fake/claude");
    expect(child.spec.cwd).toBe(repoPath);
    expect(child.spec.args[child.spec.args.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(child.spec.args[child.spec.args.indexOf("--name") + 1]).toBe("pg:chat/Build a landing page");
    expect(child.spec.env).toMatchObject({ PROMPTGRAPH_REPO: "/repo", PROMPTGRAPH_BIN: "/opt/pg/dist/cli/index.js", PATH: "/usr/bin" });
    expect(child.spec.env.CLAUDECODE).toBeUndefined();
    expect(userContent(child, 0)).toBe(
      '<promptgraph-context graph="landing" selected-nodes="n1,n2" selected-edges="" run="none" read-only="false" />\n\nBuild a landing page',
    );
    expect(manager.list()[0]!.title).toBe("Build a landing page");
    expect(manager.get("sess-1")!.session.status).toBe("starting");

    child.emit(initLine("sess-1"), ...textTurn("msg_1", ["Sure", ", done."]), resultLine("success", 0.02));
    expect(messages.filter((m) => m.type === "chat:delta")).toEqual([
      { type: "chat:delta", repoId: REPO_ID, sessionId: "sess-1", messageId: "msg_1#0", text: "Sure", offset: 0 },
      { type: "chat:delta", repoId: REPO_ID, sessionId: "sess-1", messageId: "msg_1#0", text: ", done.", offset: 4 },
    ]);
    expect(kinds()).toEqual(["user", "assistant", "result"]);
    expect(items()[0]).toMatchObject({ kind: "user", text: "Build a landing page" });
    expect(items()[2]).toMatchObject({ kind: "result", subtype: "success", isError: false, costUsd: 0.02, durationMs: 1200 });
    expect(manager.get("sess-1")!.session).toMatchObject({ status: "idle", totalCostUsd: 0.02, model: "claude-sonnet-4-5" });
    expect(store.getChatSession("sess-1")!.started).toBe(true);

    manager.send("sess-1", "Now add tests", { ...CONTEXT, selectedNodeIds: [] });
    expect(fake.children).toHaveLength(1);
    expect(userContent(child, 1)).toMatch(/selected-nodes=""[^\n]*\/>\n\nNow add tests$/);
    expect(manager.get("sess-1")!.session.status).toBe("thinking");
    child.emit(...textTurn("msg_2", ["ok"]), resultLine("success", 0.05));
    // Cumulative total 0.05 → this turn cost 0.03.
    expect(items().at(-1)).toMatchObject({ kind: "result", costUsd: 0.03 });
    expect(manager.get("sess-1")!.session.totalCostUsd).toBeCloseTo(0.05);
    expect(manager.list()[0]!.title).toBe("Build a landing page");
    expect(statuses()).toEqual(["starting", "thinking", "idle", "thinking", "idle"]);
  });

  it("shows tool rows", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    child.emit(
      initLine("sess-1"),
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: `${PLUGIN_PREFIX}get_graph`, input: { graphId: "landing" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: '{"graph":{}}' }] }] } },
    );
    expect(items().slice(1)).toMatchObject([
      { kind: "tool_use", toolUseId: "tu1", name: `${PLUGIN_PREFIX}get_graph`, input: { graphId: "landing" }, summary: "get_graph landing" },
      { kind: "tool_result", toolUseId: "tu1", isError: false, text: '{"graph":{}}' },
    ]);
  });

  function waitingOnPermission(): FakeChatChild {
    manager.create();
    manager.send("sess-1", "delete the graph", CONTEXT);
    const child = fake.last();
    child.emit(initLine("sess-1"), {
      type: "control_request",
      request_id: "perm-1",
      request: { subtype: "can_use_tool", tool_name: `${PLUGIN_PREFIX}delete_graph`, display_name: "delete_graph", input: { graphId: "old" }, tool_use_id: "tu9" },
    });
    return child;
  }

  it("round-trips an allowed permission with the exact control_response", () => {
    const child = waitingOnPermission();
    const detail = manager.get("sess-1")!;
    expect(detail.session.status).toBe("waiting_permission");
    expect(detail.pendingPermissions).toMatchObject([{ kind: "permission_request", requestId: "perm-1", toolName: `${PLUGIN_PREFIX}delete_graph`, input: { graphId: "old" } }]);

    manager.answerPermission("sess-1", "perm-1", true);
    expect(child.written.at(-1)).toBe(
      '{"type":"control_response","response":{"subtype":"success","request_id":"perm-1","response":{"behavior":"allow","updatedInput":{"graphId":"old"}}}}',
    );
    expect(items().at(-1)).toMatchObject({ kind: "permission_resolved", requestId: "perm-1", allowed: true, by: "user" });
    expect(manager.get("sess-1")!.session.status).toBe("thinking");
    expect(manager.get("sess-1")!.pendingPermissions).toEqual([]);
    expect(() => manager.answerPermission("sess-1", "perm-1", true)).toThrow(/No pending permission/);
  });

  it("round-trips a denied permission with the reason", () => {
    const child = waitingOnPermission();
    manager.answerPermission("sess-1", "perm-1", false, "keep it");
    expect(child.written.at(-1)).toBe(
      '{"type":"control_response","response":{"subtype":"success","request_id":"perm-1","response":{"behavior":"deny","message":"keep it"}}}',
    );
    expect(items().at(-1)).toMatchObject({ kind: "permission_resolved", allowed: false, by: "user" });
  });

  it("interrupts a turn and resolves the open permission prompt", () => {
    const child = waitingOnPermission();
    manager.interrupt("sess-1");
    expect(child.writtenJson.at(-1)).toEqual({ type: "control_request", request_id: "pg-interrupt-1", request: { subtype: "interrupt" } });
    expect(items().at(-1)).toMatchObject({ kind: "permission_resolved", requestId: "perm-1", allowed: false, by: "interrupt" });
    expect(manager.get("sess-1")!.session.status).toBe("thinking");
    child.emit({ type: "control_response", response: { subtype: "success", request_id: "pg-interrupt-1" } }, resultLine("error_during_execution", 0.01));
    expect(items().at(-1)).toMatchObject({ kind: "result", subtype: "error_during_execution", isError: true });
    expect(manager.get("sess-1")!.session.status).toBe("idle");
    // Nothing to interrupt now.
    const written = child.written.length;
    manager.interrupt("sess-1");
    expect(child.written).toHaveLength(written);
  });

  it("lists every open permission prompt in the detail, oldest first", () => {
    const child = waitingOnPermission();
    child.emit({
      type: "control_request",
      request_id: "perm-2",
      request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "b" }, tool_use_id: "tu10" },
    });
    expect(manager.get("sess-1")!.pendingPermissions.map((p) => p.requestId)).toEqual(["perm-1", "perm-2"]);
    manager.answerPermission("sess-1", "perm-2", true);
    expect(manager.get("sess-1")!.session.status).toBe("waiting_permission");
    expect(manager.get("sess-1")!.pendingPermissions.map((p) => p.requestId)).toEqual(["perm-1"]);
  });

  it("returns the text streamed so far for a message still streaming", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    const turn = textTurn("m1", ["Hello", " world"]);
    child.emit(initLine("sess-1"), ...turn.slice(0, 4));
    expect(manager.get("sess-1")!.streaming).toEqual([{ messageId: "m1#0", text: "Hello world" }]);
    child.emit(...turn.slice(4));
    expect(manager.get("sess-1")!.streaming).toEqual([]);
  });

  it("writes one turn at a time: a turn sent while one runs waits for its result", () => {
    manager.create();
    manager.send("sess-1", "first", CONTEXT);
    const child = fake.last();
    child.emit(initLine("sess-1"));
    manager.send("sess-1", "second", CONTEXT);
    manager.send("sess-1", "third", CONTEXT);
    expect(child.written).toHaveLength(1);
    expect(manager.get("sess-1")!.session.status).toBe("thinking");
    child.emit(resultLine("success", 0.01));
    expect(child.written).toHaveLength(2);
    expect(userContent(child, 1)).toMatch(/\n\nsecond$/);
    expect(manager.get("sess-1")!.session.status).toBe("thinking");
    child.emit(resultLine("success", 0.02));
    expect(userContent(child, 2)).toMatch(/\n\nthird$/);
    child.emit(resultLine("success", 0.03));
    expect(manager.get("sess-1")!.session.status).toBe("idle");
    expect(kinds().filter((k) => k === "result")).toHaveLength(3);
  });

  it("drops queued turns on interrupt", () => {
    manager.create();
    manager.send("sess-1", "first", CONTEXT);
    const child = fake.last();
    child.emit(initLine("sess-1"));
    manager.send("sess-1", "second", CONTEXT);
    manager.interrupt("sess-1");
    expect(child.writtenJson.at(-1)).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    child.emit(resultLine("error_during_execution"));
    expect(child.written).toHaveLength(2); // the first turn and the interrupt
    expect(manager.get("sess-1")!.session.status).toBe("idle");
  });

  it("ignores output of a deleted session's closing process (no crash, no events)", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    manager.delete("sess-1");
    const count = messages.length;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => child.emit(initLine("sess-1"), ...textTurn("m1", ["a"]), resultLine("success", 0.5))).not.toThrow();
    child.exit({ code: null, signal: "SIGTERM" });
    expect(messages).toHaveLength(count);
    expect(store.getChatSession("sess-1")).toBeUndefined();
    errors.mockRestore();
  });

  it("never throws out of the stdout listener", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    // The row disappears behind the manager's back: the store throws on update.
    store.deleteChatSession("sess-1");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => child.emit(initLine("sess-1"))).not.toThrow();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("answers unsupported control requests with an error", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    fake.last().emit({ type: "control_request", request_id: "x1", request: { subtype: "mcp_message" } });
    expect(fake.last().writtenJson.at(-1)).toMatchObject({ type: "control_response", response: { subtype: "error", request_id: "x1" } });
  });

  it("resumes with --resume after the process exited", () => {
    manager.create();
    manager.send("sess-1", "first", CONTEXT);
    const first = fake.last();
    first.emit(initLine("sess-1"), ...textTurn("m1", ["a"]), resultLine("success", 0.1));
    first.exit({ code: 0 });
    expect(manager.get("sess-1")!.session.status).toBe("exited");

    manager.send("sess-1", "second", CONTEXT);
    expect(fake.children).toHaveLength(2);
    const second = fake.last();
    expect(second.spec.args[second.spec.args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(second.spec.args).not.toContain("--session-id");
    expect(userContent(second, 0)).toMatch(/\n\nsecond$/);
    // The new process reports its own cumulative cost from 0.
    second.emit(initLine("sess-1"), resultLine("success", 0.04));
    expect(manager.get("sess-1")!.session.totalCostUsd).toBeCloseTo(0.14);
    expect(items().at(-1)).toMatchObject({ kind: "result", costUsd: 0.04 });
  });

  it("uses --session-id again when Claude never created the session", () => {
    manager.create();
    manager.send("sess-1", "first", CONTEXT);
    fake.last().emitStderr("Error: not logged in\n");
    fake.last().exit({ code: 1 });
    expect(manager.get("sess-1")!.session.status).toBe("error");
    expect(items().at(-1)).toMatchObject({ kind: "error", message: "Claude Code exited (code 1): Error: not logged in" });
    manager.send("sess-1", "again", CONTEXT);
    expect(fake.last().spec.args).toContain("--session-id");
  });

  it("resolves an open permission prompt when the process exits", () => {
    const child = waitingOnPermission();
    child.exit({ code: null, signal: "SIGKILL" });
    expect(kinds().slice(-2)).toEqual(["permission_resolved", "error"]);
    expect(items().at(-2)).toMatchObject({ by: "exit", allowed: false });
    expect(manager.get("sess-1")!.session.status).toBe("error");
  });

  it("reports a spawn failure", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    fake.last().exit({ code: null, error: new Error("spawn claude ENOENT") });
    expect(items().at(-1)).toMatchObject({ kind: "error", message: "Could not start Claude Code: spawn claude ENOENT" });
    expect(manager.get("sess-1")!.session.status).toBe("error");
  });

  it("stops an idle process after the timeout and queues a turn sent while it exits", () => {
    vi.useFakeTimers();
    manager = makeManager({ idleTimeoutMs: 1000, shutdownGraceMs: 100 });
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    child.emit(initLine("sess-1"), resultLine());
    vi.advanceTimersByTime(999);
    expect(child.stdinOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(child.stdinOpen).toBe(false);
    vi.advanceTimersByTime(100);
    expect(child.signals).toEqual(["SIGTERM"]);

    manager.send("sess-1", "still there?", CONTEXT);
    expect(fake.children).toHaveLength(1);
    child.exit({ code: null, signal: "SIGTERM" });
    expect(fake.children).toHaveLength(2);
    expect(fake.last().spec.args).toContain("--resume");
    expect(userContent(fake.last(), 0)).toMatch(/still there\?$/);
    expect(kinds()).not.toContain("error");
  });

  it("does not stop a process while a turn is running", () => {
    vi.useFakeTimers();
    manager = makeManager({ idleTimeoutMs: 1000 });
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    fake.last().emit(initLine("sess-1"), resultLine());
    vi.advanceTimersByTime(500);
    manager.send("sess-1", "long one", CONTEXT);
    vi.advanceTimersByTime(5000);
    expect(fake.last().stdinOpen).toBe(true);
  });

  it("shuts down: closes stdin, SIGTERM after the grace period", async () => {
    vi.useFakeTimers();
    manager = makeManager({ shutdownGraceMs: 3000 });
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    let done = false;
    const closing = manager.shutdown().then(() => (done = true));
    expect(child.stdinOpen).toBe(false);
    vi.advanceTimersByTime(2999);
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    child.exit({ code: null, signal: "SIGTERM" });
    await closing;
    expect(done).toBe(true);
    expect(() => manager.send("sess-1", "x", CONTEXT)).toThrow(/shutting down/);
  });

  it("deletes a session: kills the process and removes the metadata", () => {
    manager.create();
    manager.send("sess-1", "hi", CONTEXT);
    const child = fake.last();
    expect(manager.delete("sess-1")).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.stdinOpen).toBe(false);
    expect(store.getChatSession("sess-1")).toBeUndefined();
    expect(messages.at(-1)).toEqual({ type: "chat:deleted", repoId: REPO_ID, sessionId: "sess-1" });
    const count = messages.length;
    child.exit({ code: null, signal: "SIGTERM" });
    expect(messages).toHaveLength(count);
    expect(manager.delete("sess-1")).toBe(false);
  });

  it("rebuilds the history from the Claude transcript after a restart", () => {
    manager.create();
    store.updateChatSession("sess-1", { started: true, title: "Landing" });
    const transcriptDir = path.join(env.CLAUDE_CONFIG_DIR!, "projects", projectDirName(repoPath));
    expect(projectDirName(repoPath)).toBe("-work-my-repo");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const lines = [
      { type: "summary", summary: "x" },
      { type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: '<promptgraph-context graph="g" selected-nodes="" selected-edges="" run="none" read-only="false" />\n\nBuild it' } },
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Reading." }] } },
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: `${repoPath}/a.ts` } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file" }] } },
      { type: "assistant", isSidechain: true, message: { id: "side", content: [{ type: "text", text: "hidden" }] } },
      { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      "{broken",
    ];
    fs.writeFileSync(path.join(transcriptDir, "sess-1.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
    expect(findChatTranscript(repoPath, "sess-1", env)).toBe(path.join(transcriptDir, "sess-1.jsonl"));

    const restarted = makeManager();
    const detail = restarted.get("sess-1")!;
    expect(detail.session).toMatchObject({ title: "Landing", status: "idle" });
    expect(detail.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool_use", "tool_result"]);
    expect(detail.items[0]).toMatchObject({ text: "Build it", ts: Date.parse("2026-01-01T00:00:00.000Z") });
    expect(detail.items[2]).toMatchObject({ summary: "Read a.ts" });
    expect(new Set(detail.items.map((i) => i.id)).size).toBe(4);

    // A missing transcript gives an empty history.
    expect(chatItemsFromTranscript(path.join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("only sees the sessions of its repository", () => {
    store.insertChatSession({ id: "other", repoPath: "/other" });
    expect(manager.list()).toEqual([]);
    expect(manager.get("other")).toBeUndefined();
  });

  it("titles chats from the first line, truncated", () => {
    expect(chatTitle("  hello\n  world ")).toBe("hello world");
    expect(chatTitle("x".repeat(200))).toHaveLength(80);
    expect(chatTitle("   ")).toBe("New chat");
  });
});

// --- HTTP / WS ---------------------------------------------------------------------------------

describe("chat routes", () => {
  const HEADERS = { host: "127.0.0.1:4777", authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };
  let cleanups: Array<() => void>;
  let daemon: TestDaemon;
  let fake: ReturnType<typeof fakeSpawner>;
  let api: ReturnType<typeof API.repo>;

  beforeEach(async () => {
    const t = tempDir();
    const r = createTempRepo();
    cleanups = [r.cleanup, t.cleanup];
    fake = fakeSpawner();
    daemon = await createTestDaemon({ root: t.dir, repos: [r.repo], mockEngines: true, env: { CLAUDE_CONFIG_DIR: path.join(t.dir, "claude") }, chatSpawner: fake.spawner });
    api = API.repo(daemon.repoIds[0]!);
  });
  afterEach(async () => {
    await daemon.close();
    for (const c of cleanups) c();
  });

  it("creates, lists, reads and deletes sessions behind the token", async () => {
    const app = createHttpApp(daemon.ctx);
    expect((await app.request(api.chatSessions, { headers: { host: HEADERS.host } })).status).toBe(401);

    const created = await app.request(api.chatSessions, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "opus" }) });
    expect(created.status).toBe(200);
    const { session } = (await created.json()) as { session: { id: string; model: string } };
    expect(session.model).toBe("opus");
    expect((await app.request(api.chatSessions, { method: "POST", headers: HEADERS, body: JSON.stringify({ model: "" }) })).status).toBe(400);

    const list = (await (await app.request(api.chatSessions, { headers: HEADERS })).json()) as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(1);

    (await daemon.repo(daemon.repoIds[0]!)).chat.send(session.id, "hello", CONTEXT);
    const detail = (await (await app.request(api.chatSession(session.id), { headers: HEADERS })).json()) as { items: ChatItem[] };
    expect(detail.items).toMatchObject([{ kind: "user", text: "hello" }]);

    expect((await app.request(api.chatSession(session.id), { method: "DELETE", headers: HEADERS })).status).toBe(200);
    expect(fake.last().signals).toEqual(["SIGTERM"]);
    expect((await app.request(api.chatSession(session.id), { headers: HEADERS })).status).toBe(404);
    expect((await app.request(api.chatSession(session.id), { method: "DELETE", headers: HEADERS })).status).toBe(404);
  });
});

// --- real child process (a stand-in script, never the real claude) ------------------------------

describe("spawnChatProcess", () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it("drives a stream-json process over pipes, turn after turn", async () => {
    const script = path.join(dir, "stream-claude");
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "user") return;
  n++;
  if (n === 1) out({ type: "system", subtype: "init", session_id: "s", model: "m", mcp_servers: [{ name: "plugin:promptgraph:promptgraph", status: "connected" }] });
  out({ type: "assistant", message: { id: "m" + n, content: [{ type: "text", text: "echo " + msg.message.content.split("\\n\\n").pop() + " " + process.argv.includes("--resume") + " " + process.env.PROMPTGRAPH_REPO }] } });
  out({ type: "result", subtype: "success", is_error: false, total_cost_usd: n / 100 });
});
rl.on("close", () => process.exit(0));
`,
      { mode: 0o755 },
    );
    const store = new Store(openDatabase(":memory:"));
    const manager = new ChatManager({ store, bus: new EventBus(), repoId: REPO_ID, repoPath: dir, env: { ...process.env, PG_CLAUDE_BIN: script }, mcp: () => MCP, shutdownGraceMs: 200 });
    const { id } = manager.create();
    const texts = () => manager.get(id)!.items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text);
    manager.send(id, "one", CONTEXT);
    await vi.waitFor(() => expect(texts()).toEqual(["echo one false /repo"]), { timeout: 5000 });
    manager.send(id, "two", CONTEXT);
    await vi.waitFor(() => expect(manager.get(id)!.session).toMatchObject({ status: "idle", totalCostUsd: 0.02 }), { timeout: 5000 });
    expect(texts()).toEqual(["echo one false /repo", "echo two false /repo"]);
    await manager.shutdown();
    expect(manager.get(id)!.session.status).toBe("exited");
    store.db.close();
  });

  it("reports a missing binary", async () => {
    const store = new Store(openDatabase(":memory:"));
    const manager = new ChatManager({ store, bus: new EventBus(), repoId: REPO_ID, repoPath: dir, env: { PATH: "", PG_CLAUDE_BIN: path.join(dir, "missing") }, mcp: () => MCP });
    const { id } = manager.create();
    manager.send(id, "hi", CONTEXT);
    await vi.waitFor(() => expect(manager.get(id)!.session.status).toBe("error"), { timeout: 5000 });
    expect(manager.get(id)!.items.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("Could not start Claude Code") });
    store.db.close();
  });
});
