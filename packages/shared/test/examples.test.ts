import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GraphSchema, validateGraph } from "../src/index.js";

const EXAMPLES_DIR = path.resolve(import.meta.dirname, "../../../docs/examples");
const files = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".json"));

/** docs/examples/*.json are copied by users into .promptgraph/graphs/: they must stay valid. */
describe("docs/examples", () => {
  it("has the documented examples", () => {
    expect(files.sort()).toEqual(["fan-out-merge-pr.json", "linear.json", "review-loop.json", "test-fix-loop.json"]);
  });

  it.each(files)("%s parses and validates without errors (only expected warnings)", (file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), "utf8")) as unknown;
    const graph = GraphSchema.parse(raw);
    expect(`${graph.id}.json`).toBe(file);
    const result = validateGraph(graph, { phase: 2 });
    expect(result.errors).toEqual([]);
    // Merging lanes with uncommitted work is fine: they are checkpointed automatically.
    expect(result.warnings.filter((w) => w.code !== "uncommitted_before_merge")).toEqual([]);
  });
});
