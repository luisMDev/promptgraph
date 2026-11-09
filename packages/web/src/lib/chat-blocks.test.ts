import type { ChatItem } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { buildChatBlocks, groupTitle, stepLabel, stepStatus } from "./chat-blocks";

const PG = "mcp__plugin_promptgraph_promptgraph__";
let n = 0;
const use = (name: string, input: unknown = {}, summary = name): Extract<ChatItem, { kind: "tool_use" }> => ({
  id: `i${++n}`,
  ts: n,
  kind: "tool_use",
  toolUseId: `tu-${name}-${n}`,
  name,
  input,
  summary,
});
const result = (toolUseId: string, isError = false): ChatItem => ({ id: `i${++n}`, ts: n, kind: "tool_result", toolUseId, isError, text: "ok" });
const text = (t: string): ChatItem => ({ id: `i${++n}`, ts: n, kind: "assistant", messageId: `m${n}`, text: t });

describe("buildChatBlocks", () => {
  it("folds consecutive tool calls with their results into one group, split by text", () => {
    const read = use("Read", { file_path: "a.ts" }, "Read a.ts");
    const grep = use("Grep", {}, 'Grep "x"');
    const patch = use(`${PG}patch_graph`, { graphId: "g", ops: [{}, {}] });
    const items: ChatItem[] = [
      { id: "u", ts: 0, kind: "user", text: "hi" },
      read,
      result(read.toolUseId),
      grep,
      result(grep.toolUseId),
      text("Now the graph."),
      patch,
      { id: "r", ts: 99, kind: "result", subtype: "success", isError: false },
    ];
    const blocks = buildChatBlocks(items);
    expect(blocks.map((b) => b.type)).toEqual(["item", "tools", "item", "tools"]);
    const [, first, , second] = blocks;
    expect(first?.type === "tools" && first.steps.map(stepStatus)).toEqual(["done", "done"]);
    expect(second?.type === "tools" && second.steps.map(stepStatus)).toEqual(["running"]);
    expect(first?.type === "tools" && groupTitle(first.steps)).toBe("Read a file, searched the code");
    // While a call runs the title is that call.
    expect(second?.type === "tools" && groupTitle(second.steps)).toBe("Update graph g · 2 changes");
  });

  it("draws permission answers on their call and keeps permission prompts from splitting a group", () => {
    const write = use("Write", { file_path: "x" }, "Write x");
    const bash = use("Bash", { command: "ls" }, "Bash: ls");
    const items: ChatItem[] = [
      write,
      { id: "p1", ts: 1, kind: "permission_request", requestId: "r1", toolName: "Write", input: {}, toolUseId: write.toolUseId },
      { id: "p2", ts: 2, kind: "permission_resolved", requestId: "r1", allowed: false, by: "user" },
      result(write.toolUseId, true),
      bash,
      result(bash.toolUseId),
    ];
    const blocks = buildChatBlocks(items);
    expect(blocks).toHaveLength(1);
    const group = blocks[0]!;
    if (group.type !== "tools") throw new Error("expected a group");
    expect(group.steps[0]!.permission).toMatchObject({ allowed: false });
    expect(group.steps.map(stepStatus)).toEqual(["denied", "done"]);
    expect(groupTitle(group.steps)).toBe("Edited a file, ran a command");
  });

  it("makes AskUserQuestion its own block with the answers", () => {
    const ask = use("AskUserQuestion", { questions: [{ question: "How complex?", options: [{ label: "Simple" }] }] });
    const read = use("Read");
    const blocks = buildChatBlocks([
      read,
      ask,
      { id: "q", ts: 5, kind: "tool_result", toolUseId: ask.toolUseId, isError: false, text: "answered", answers: { "How complex?": "Simple" } },
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["tools", "question"]);
    expect(blocks[1]?.type === "question" && blocks[1].step.result?.answers).toEqual({ "How complex?": "Simple" });
  });

  it("labels promptgraph tools and skills for people", () => {
    expect(stepLabel(use(`${PG}graph_reference`))).toBe("Read the graph format");
    expect(stepLabel(use(`${PG}save_graph`, { graph: { id: "landing" } }))).toBe("Save graph landing");
    expect(stepLabel(use("Skill", { skill: "promptgraph:design-graph" }))).toBe("Use the design-graph skill");
    expect(stepLabel(use("Read", {}, "Read src/app.ts"))).toBe("Read src/app.ts");
    expect(groupTitle([{ use: use(`${PG}save_graph`), result: result("x") as never }])).toBe("Saved the graph");
  });
});
