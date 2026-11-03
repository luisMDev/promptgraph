import { afterEach, describe, expect, it, vi } from "vitest";
import { api, currentRepoId, repoIdFromPath, resetCurrentRepo } from "./rest";

describe("repository resolution (temporary, until the router)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCurrentRepo();
  });

  it("reads the /r/<repoId> prefix", () => {
    expect(repoIdFromPath("/r/demo-0123abcd")).toBe("demo-0123abcd");
    expect(repoIdFromPath("/r/demo-0123abcd/graphs/x")).toBe("demo-0123abcd");
    expect(repoIdFromPath("/")).toBeNull();
    expect(repoIdFromPath("/r/%E0%A4%A")).toBeNull();
  });

  it("falls back to the most recently opened repository and scopes repository calls by it", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      const body =
        url === "/api/repos"
          ? {
              repos: [
                { id: "old-00000001", addedAt: 1, lastOpenedAt: 5 },
                { id: "new-00000002", addedAt: 2, lastOpenedAt: 9 },
                { id: "never-00000003", addedAt: 3, lastOpenedAt: null },
              ],
            }
          : { graphs: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    expect(await currentRepoId()).toBe("new-00000002");
    await api.listGraphs();
    expect(calls).toEqual(["/api/repos", "/api/repos/new-00000002/graphs"]);
  });

  it("reports that no repository is registered, and retries later", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ repos: [] }), { status: 200 }));
    await expect(currentRepoId()).rejects.toThrow("No repository is registered");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ repos: [{ id: "a-00000001", addedAt: 1, lastOpenedAt: null }] }), { status: 200 }));
    expect(await currentRepoId()).toBe("a-00000001");
  });
});
