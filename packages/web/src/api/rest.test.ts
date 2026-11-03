import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, daemonApi, onUnauthorized, repoApi } from "./rest";

describe("REST client", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status = 200, body: unknown = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    });
    return calls;
  }

  it("scopes repository routes by the repository id and sends no credential of its own", async () => {
    const calls = stubFetch(200, { graphs: [] });
    const api = repoApi("demo-0123abcd");
    await api.listGraphs();
    await api.listRuns("g1", 10);
    await api.claudeCheck();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/repos/demo-0123abcd/graphs",
      "/api/repos/demo-0123abcd/runs?graph=g1&limit=10",
      "/api/repos/demo-0123abcd/claude-setup/check",
    ]);
    for (const { init } of calls) {
      expect(init.credentials).toBe("same-origin");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    }
    expect(new Headers(calls[2]!.init.headers).get("Content-Type")).toBe("application/json");
  });

  it("daemon routes: repos, add, remove with force, settings", async () => {
    const calls = stubFetch(200, { repos: [] });
    await daemonApi.repos();
    await daemonApi.addRepo("~/code/demo");
    await daemonApi.removeRepo("demo-0123abcd");
    await daemonApi.removeRepo("demo-0123abcd", true);
    await daemonApi.getSettings();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/repos",
      "POST /api/repos",
      "DELETE /api/repos/demo-0123abcd",
      "DELETE /api/repos/demo-0123abcd?force=1",
      "GET /api/settings",
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ path: "~/code/demo" });
  });

  it("throws the server's ApiError and reports 401 as signed out", async () => {
    stubFetch(401, { error: "Unauthorized", code: "unauthorized" });
    const signedOut = vi.fn();
    const off = onUnauthorized(signedOut);
    const err = await daemonApi.daemon().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(signedOut).toHaveBeenCalledTimes(1);
    off();
    stubFetch(422, { error: "Not a git repository", code: "not_a_git_repo" });
    await expect(daemonApi.addRepo("/tmp")).rejects.toMatchObject({ status: 422, body: { code: "not_a_git_repo" } });
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it("saves graphs with keepalive, so a save flushed on pagehide survives the page", async () => {
    const calls = stubFetch(200, { graph: {}, hash: "h" });
    await repoApi("demo-0123abcd").saveGraph({ id: "g1" } as never);
    expect(calls[0]!.init).toMatchObject({ method: "PUT", keepalive: true });
  });
});
