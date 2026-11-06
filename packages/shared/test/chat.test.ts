import { describe, expect, it } from "vitest";
import {
  buildChatContextBlock,
  ChatItemSchema,
  ClientMessageSchema,
  EMPTY_CHAT_CONTEXT,
  ServerMessageSchema,
  shortToolName,
  stripChatContext,
  withChatContext,
} from "../src/index.js";

describe("chat context block", () => {
  it("renders the documented attribute order", () => {
    const block = buildChatContextBlock({
      graphId: "landing",
      selectedNodeIds: ["n1", "n2"],
      selectedEdgeIds: [],
      runId: null,
      readOnly: false,
    });
    expect(block).toBe('<promptgraph-context graph="landing" selected-nodes="n1,n2" selected-edges="" run="none" read-only="false" />');
  });

  it("writes none for a missing graph and includes graph-name and run when given", () => {
    expect(buildChatContextBlock(EMPTY_CHAT_CONTEXT)).toBe(
      '<promptgraph-context graph="none" selected-nodes="" selected-edges="" run="none" read-only="false" />',
    );
    const block = buildChatContextBlock({ ...EMPTY_CHAT_CONTEXT, graphId: "g", graphName: "My graph", runId: "r1", readOnly: true });
    expect(block).toBe('<promptgraph-context graph="g" graph-name="My graph" selected-nodes="" selected-edges="" run="r1" read-only="true" />');
  });

  it("escapes attribute values", () => {
    const block = buildChatContextBlock({ ...EMPTY_CHAT_CONTEXT, graphId: "g", graphName: 'a "b" <c> & d\ne' });
    expect(block).toContain('graph-name="a &quot;b&quot; &lt;c&gt; &amp; d&#10;e"');
    expect(block.match(/"/g)!.length % 2).toBe(0);
  });

  it("prepends the block with a blank line and strips it back", () => {
    const content = withChatContext({ ...EMPTY_CHAT_CONTEXT, graphId: "g" }, "remove this node\n\nplease");
    expect(content).toMatch(/^<promptgraph-context [^\n]* \/>\n\nremove this node\n\nplease$/);
    expect(stripChatContext(content)).toBe("remove this node\n\nplease");
    expect(stripChatContext("plain text")).toBe("plain text");
  });
});

describe("chat schemas", () => {
  it("shortens promptgraph MCP tool names", () => {
    expect(shortToolName("mcp__plugin_promptgraph_promptgraph__patch_graph")).toBe("patch_graph");
    expect(shortToolName("mcp__promptgraph__get_graph")).toBe("get_graph");
    expect(shortToolName("mcp__github__create_issue")).toBe("github/create_issue");
    expect(shortToolName("Read")).toBe("Read");
  });

  it("parses every item kind", () => {
    const base = { id: "i", ts: 1 };
    const items = [
      { ...base, kind: "user", text: "hi" },
      { ...base, kind: "assistant", messageId: "m", text: "hello" },
      { ...base, kind: "tool_use", toolUseId: "t", name: "Read", input: { file_path: "a" }, summary: "Read a" },
      { ...base, kind: "tool_result", toolUseId: "t", isError: false, text: "ok" },
      { ...base, kind: "permission_request", requestId: "r", toolName: "Bash", input: { command: "ls" } },
      { ...base, kind: "permission_resolved", requestId: "r", allowed: true, by: "user" },
      { ...base, kind: "result", subtype: "success", isError: false, costUsd: 0.01 },
      { ...base, kind: "error", message: "boom" },
      { ...base, kind: "notice", text: "note" },
    ];
    for (const item of items) expect(ChatItemSchema.parse(item)).toEqual(item);
  });

  it("extends the WS unions with chat messages", () => {
    expect(
      ClientMessageSchema.parse({ type: "chat:send", sessionId: "s", text: "x", context: EMPTY_CHAT_CONTEXT }).type,
    ).toBe("chat:send");
    expect(ClientMessageSchema.parse({ type: "chat:permission", sessionId: "s", requestId: "r", allow: false, message: "no" }).type).toBe(
      "chat:permission",
    );
    expect(ClientMessageSchema.safeParse({ type: "chat:send", sessionId: "s", text: "", context: EMPTY_CHAT_CONTEXT }).success).toBe(false);
    expect(ServerMessageSchema.parse({ type: "chat:delta", sessionId: "s", messageId: "m", text: "he", offset: 0 }).type).toBe("chat:delta");
    expect(ServerMessageSchema.parse({ type: "chat:status", sessionId: "s", status: "thinking" }).type).toBe("chat:status");
  });
});
