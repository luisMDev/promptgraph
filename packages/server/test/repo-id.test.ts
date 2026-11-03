import { describe, expect, it } from "vitest";
import { REPO_ID_PATTERN } from "@promptgraph/shared";
import { repoIdFor, repoSlug } from "../src/config/repo-id.js";

describe("repository ids (DESIGN §4.2)", () => {
  it("slugs: lowercase, runs of other characters → '-', trimmed, ≤ 24 characters, 'repo' if empty", () => {
    expect(repoSlug("promptgraph")).toBe("promptgraph");
    expect(repoSlug("My App")).toBe("my-app");
    expect(repoSlug("--Foo__Bar..baz--")).toBe("foo-bar-baz");
    expect(repoSlug("Ünïcode ✓ repo")).toBe("n-code-repo");
    expect(repoSlug("")).toBe("repo");
    expect(repoSlug("___")).toBe("repo");
    expect(repoSlug("a".repeat(30))).toBe("a".repeat(24));
    // Cut at 24, then no trailing dash.
    expect(repoSlug(`${"a".repeat(23)}-bcd`)).toBe("a".repeat(23));
  });

  it("ids are <slug>-<hash8>, stable, and distinct for two paths with the same basename", () => {
    const a = repoIdFor("/home/u/work/app");
    expect(a).toMatch(/^app-[0-9a-f]{8}$/);
    expect(repoIdFor("/home/u/work/app")).toBe(a);
    const b = repoIdFor("/home/u/other/app");
    expect(b).toMatch(/^app-[0-9a-f]{8}$/);
    expect(b).not.toBe(a);
  });

  it("every derived id matches REPO_ID_PATTERN", () => {
    for (const p of ["/x/promptgraph", "/x/My Repo", "/x/___", "/", `/x/${"z".repeat(40)}`, "/x/a", "/x/9-lives", "/x/.dotfiles"]) {
      expect(REPO_ID_PATTERN.test(repoIdFor(p)), `${p} → ${repoIdFor(p)}`).toBe(true);
    }
  });
});
