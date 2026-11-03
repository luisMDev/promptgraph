import path from "node:path";
import { describe, expect, it } from "vitest";
import { pgHome } from "../src/config/paths.js";

describe("pgHome", () => {
  it("resolves PG_HOME", () => {
    expect(pgHome({ PG_HOME: "/tmp/x/../pg" })).toBe(path.resolve("/tmp/pg"));
  });

  it("the global test setup gives every run a throwaway PG_HOME", () => {
    expect(process.env.PG_HOME).toMatch(/pg-test-home-/);
  });

  it("refuses to fall back to ~/.promptgraph under vitest", () => {
    expect(() => pgHome({ VITEST: "true" })).toThrow(/PG_HOME must be set/);
  });
});
