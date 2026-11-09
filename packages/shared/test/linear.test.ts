import { describe, expect, it } from "vitest";
import {
  LinearIssuesQuerySchema,
  stateTypesOfGroups,
  branchPrefixForIssue,
  createEmptyGraph,
  graphNameForIssue,
  GraphSchema,
  parseIssueReference,
  validateGraph,
  withIssueReferences,
  MAX_GRAPH_ISSUES,
  type GraphIssue,
} from "../src/index.js";

const ISSUE: GraphIssue = {
  provider: "linear",
  id: "9c1a7e2e-0000-4000-8000-000000000001",
  identifier: "ENG-123",
  title: "Add Linear issues to new graphs",
  url: "https://linear.app/acme/issue/ENG-123/add-linear-issues-to-new-graphs",
  branchName: "luis/eng-123-add-linear-issues-to-new-graphs",
};

describe("parseIssueReference", () => {
  it("recognises identifiers in any case and linear.app issue URLs", () => {
    expect(parseIssueReference("ENG-123")).toBe("ENG-123");
    expect(parseIssueReference(" eng-42 ")).toBe("ENG-42");
    expect(parseIssueReference("https://linear.app/acme/issue/ENG-123/add-linear")).toBe("ENG-123");
    expect(parseIssueReference("https://linear.app/acme/issue/web2-7")).toBe("WEB2-7");
  });

  it("treats anything else as search text", () => {
    for (const text of ["", "add linear", "ENG-", "ENG-0", "123-ENG", "https://example.com/acme/issue/ENG-1", "http://linear.app/acme/issue/ENG-1"]) {
      expect(parseIssueReference(text)).toBeNull();
    }
  });
});

describe("issue defaults", () => {
  it("names the graph after the identifier and title", () => {
    expect(graphNameForIssue(ISSUE)).toBe("ENG-123 Add Linear issues to new graphs");
    expect(graphNameForIssue({ identifier: "ENG-1", title: "  " })).toBe("ENG-1");
  });

  it("uses Linear's branch name as the prefix when it is a valid one, pg/<identifier> otherwise", () => {
    expect(branchPrefixForIssue(ISSUE)).toBe("luis/eng-123-add-linear-issues-to-new-graphs");
    expect(branchPrefixForIssue({ identifier: "ENG-123" })).toBe("pg/eng-123");
    expect(branchPrefixForIssue({ identifier: "ENG-123", branchName: "bad..name" })).toBe("pg/eng-123");
  });

  it("creates a graph linked to several issues, on the first one's branch prefix, that validates", () => {
    const second: GraphIssue = { ...ISSUE, id: "second", identifier: "ENG-7", branchName: "luis/eng-7-other" };
    const graph = createEmptyGraph("eng-123", graphNameForIssue(ISSUE), "main", [ISSUE, second]);
    expect(graph.issues).toEqual([ISSUE, second]);
    expect(graph.settings.branchPrefix).toBe(ISSUE.branchName);
    expect(validateGraph(graph).errors.filter((e) => e.code === "invalid_config")).toEqual([]);
    expect(createEmptyGraph("plain", "Plain").issues).toBeUndefined();
    expect(createEmptyGraph("plain", "Plain", "main", []).issues).toBeUndefined();
  });

  it("accepts graph files without issues; refuses non-https URLs, bad identifiers, duplicates and too many", () => {
    const base = { version: 1, id: "g", name: "G" };
    expect(GraphSchema.safeParse(base).success).toBe(true);
    expect(GraphSchema.safeParse({ ...base, issues: [ISSUE] }).success).toBe(true);
    expect(GraphSchema.safeParse({ ...base, issues: [{ ...ISSUE, url: "javascript:alert(1)" }] }).success).toBe(false);
    expect(GraphSchema.safeParse({ ...base, issues: [{ ...ISSUE, identifier: "not an id" }] }).success).toBe(false);
    expect(GraphSchema.safeParse({ ...base, issues: [ISSUE, ISSUE] }).success).toBe(false);
    const many = Array.from({ length: MAX_GRAPH_ISSUES + 1 }, (_, i) => ({ ...ISSUE, id: `i${i}`, identifier: `ENG-${i + 1}` }));
    expect(GraphSchema.safeParse({ ...base, issues: many }).success).toBe(false);
    expect(GraphSchema.safeParse({ ...base, issues: many.slice(1) }).success).toBe(true);
  });
});

describe("withIssueReferences", () => {
  const A = { identifier: "ENG-123" };
  const B = { identifier: "ENG-7" };

  it("adds every identifier to the title and one Fixes line each to the body", () => {
    expect(withIssueReferences({ title: "feat: link graphs to Linear", body: "Adds the picker.\n" }, [A])).toEqual({
      title: "feat: link graphs to Linear (ENG-123)",
      body: "Adds the picker.\n\nFixes ENG-123",
    });
    expect(withIssueReferences({ title: "t", body: "" }, [A, B])).toEqual({ title: "t (ENG-123, ENG-7)", body: "Fixes ENG-123\nFixes ENG-7" });
  });

  it("only adds what is not mentioned yet, and leaves graphs without issues unchanged", () => {
    const named = { title: "ENG-123: link graphs", body: "Closes eng-123" };
    expect(withIssueReferences(named, [A])).toEqual(named);
    expect(withIssueReferences(named, [A, B])).toEqual({ title: "ENG-123: link graphs (ENG-7)", body: "Closes eng-123\n\nFixes ENG-7" });
    const other = { title: "Fix ENG-1234 too", body: "See ENG-12" };
    expect(withIssueReferences(other, [A])).toEqual({ title: "Fix ENG-1234 too (ENG-123)", body: "See ENG-12\n\nFixes ENG-123" });
    expect(withIssueReferences(named, undefined)).toBe(named);
    expect(withIssueReferences(named, [])).toBe(named);
  });
});

describe("state filter", () => {
  it("maps groups to state types in workflow order; no group means every type", () => {
    expect(stateTypesOfGroups(["started", "backlog", "todo"])).toEqual(["triage", "backlog", "unstarted", "started"]);
    expect(stateTypesOfGroups(["done", "canceled"])).toEqual(["completed", "canceled"]);
    expect(stateTypesOfGroups([])).toEqual(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);
    expect(stateTypesOfGroups(["nope"])).toHaveLength(6);
  });

  it("parses the states query: absent or empty = open work, duplicates dropped, unknown types refused", () => {
    expect(LinearIssuesQuerySchema.parse({ q: "x" }).states).toEqual(["triage", "backlog", "unstarted", "started"]);
    expect(LinearIssuesQuerySchema.parse({ q: "x", states: "" }).states).toEqual(["triage", "backlog", "unstarted", "started"]);
    expect(LinearIssuesQuerySchema.parse({ q: "x", states: "completed, completed,canceled" }).states).toEqual(["completed", "canceled"]);
    expect(LinearIssuesQuerySchema.safeParse({ q: "x", states: "done" }).success).toBe(false);
  });
});
