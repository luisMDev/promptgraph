// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, parseBlocks, parseInline, safeHref } from "./markdown";

describe("markdown", () => {
  afterEach(cleanup);

  it("splits blocks: headings, lists, code fences, quotes and paragraphs", () => {
    const blocks = parseBlocks(["# Plan", "", "1. Read", "2. Write", "", "- a", "  continued", "- b", "", "```ts", "const x = 1;", "```", "> note", "", "Done."].join("\n"));
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Plan" },
      { kind: "list", ordered: true, start: 1, items: ["Read", "Write"] },
      { kind: "list", ordered: false, start: 1, items: ["a\ncontinued", "b"] },
      { kind: "code", lang: "ts", text: "const x = 1;" },
      { kind: "quote", text: "note" },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("keeps an unclosed fence (streaming) as code", () => {
    expect(parseBlocks("```\npartial")).toEqual([{ kind: "code", lang: "", text: "partial" }]);
  });

  it("tokenises inline code, emphasis and links", () => {
    expect(parseInline("Use `patch_graph` **now** and *then* [docs](https://x.dev)")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "patch_graph" },
      { kind: "text", text: " " },
      { kind: "strong", children: [{ kind: "text", text: "now" }] },
      { kind: "text", text: " and " },
      { kind: "em", children: [{ kind: "text", text: "then" }] },
      { kind: "text", text: " " },
      { kind: "link", href: "https://x.dev", children: [{ kind: "text", text: "docs" }] },
    ]);
    // snake_case words are not emphasis.
    expect(parseInline("insert_after node")).toEqual([{ kind: "text", text: "insert_after node" }]);
  });

  it("never renders raw HTML or unsafe links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> [click](javascript:alert(1)) <script>bad()</script>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("renders lists, code and links as elements", () => {
    const { container } = render(<Markdown text={"- one\n- two\n\n`x` [a](https://a.dev)"} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("x");
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://a.dev");
    expect(a.getAttribute("rel")).toContain("noopener");
  });
});
