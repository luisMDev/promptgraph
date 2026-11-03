import fs from "node:fs";
import path from "node:path";
import { createEmptyGraph, type GraphInput, type RunDetail } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoIdFor } from "../src/config/repo-id.js";
import { helloProof } from "../src/config/token.js";
import { EngineError } from "../src/engine/engine.js";
import { hookToken } from "../src/hooks/hook-token.js";
import { createHttpApp } from "../src/http/app.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { createTestDaemon, TEST_HOOK_SECRET, TEST_TOKEN, type EngineMock, type TestDaemon } from "./support/test-daemon.js";
import { sessionCookieValue } from "../src/hooks/hook-token.js";

vi.mock("../src/git/repo.js", async (orig) => ({
  ...(await orig<typeof import("../src/git/repo.js")>()),
  currentBranch: vi.fn(async () => "main"),
  listBranches: vi.fn(async () => ["main", "dev"]),
}));

const HOST = { host: "127.0.0.1:4777" };
const AUTH = { ...HOST, authorization: `Bearer ${TEST_TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

function promptGraph(id: string): GraphInput {
  return {
    version: 1,
    id,
    name: "Demo",
    settings: { baseBranch: "main" },
    nodes: [{ id: "a", type: "prompt", label: "Implement", position: { x: 0, y: 0 }, config: { prompt: "Do it" } }],
    edges: [],
  };
}

let repo: string;
let root: string;
let cleanups: Array<() => void>;
let daemon: TestDaemon;
let app: ReturnType<typeof createHttpApp>;
let repoId: string;
/** Prefix of this repository's routes. */
let R: string;
let engine: EngineMock;
/** The repository's context (graph store) and the daemon context. */
const setup = {
  get ctx() {
    return daemon.ctx;
  },
  get engine() {
    return engine;
  },
};

beforeEach(async () => {
  const r = createTempRepo();
  const t = tempDir();
  repo = r.repo;
  root = t.dir;
  cleanups = [r.cleanup, t.cleanup];
  daemon = await createTestDaemon({ root, repos: [repo], mockEngines: true, env: { PG_WEB_DIST: path.join(root, "dist"), CLAUDE_CONFIG_DIR: path.join(root, "claude") } });
  repoId = daemon.repoIds[0]!;
  R = `/api/repos/${repoId}`;
  engine = daemon.engines.get(repoId)!;
  app = createHttpApp(daemon.ctx);
});

afterEach(async () => {
  await daemon.close();
  for (const c of cleanups) c();
});

const graphs = async () => (await daemon.repo(repoId)).graphs;

describe("security middleware", () => {
  it("rejects non-localhost Host and Origin (DNS rebinding)", async () => {
    expect((await app.request(`${R}/graphs`, { headers: { ...AUTH, host: "evil.example:4777" } })).status).toBe(403);
    expect((await app.request(`${R}/graphs`, { headers: { ...AUTH, origin: "http://evil.example" } })).status).toBe(403);
    expect((await app.request(`${R}/graphs`, { headers: { ...AUTH, host: "localhost:5173", origin: "http://localhost:5173" } })).status).toBe(200);
  });

  it("requires the token on API, hooks and pages", async () => {
    const res = await app.request(`${R}/graphs`, { headers: HOST });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
    expect((await app.request(`${R}/graphs`, { headers: { ...HOST, authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request("/hooks/x/stop", { method: "POST", headers: HOST, body: "{}" })).status).toBe(401);
    expect((await app.request("/", { headers: HOST })).status).toBe(401);
  });

  it("sets the cookie from ?t= and redirects without it", async () => {
    const res = await app.request(`/runs?x=1&t=${TEST_TOKEN}`, { headers: HOST });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/runs?x=1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`pg_token=${sessionCookieValue(TEST_TOKEN)}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toContain(TEST_TOKEN);
    const ok = await app.request(`${R}/graphs`, { headers: { ...HOST, cookie: `pg_token=${sessionCookieValue(TEST_TOKEN)}` } });
    expect(ok.status).toBe(200);
    // The cookie value is no Bearer credential, and the raw token is no cookie.
    expect((await app.request(`${R}/graphs`, { headers: { ...HOST, authorization: `Bearer ${sessionCookieValue(TEST_TOKEN)}` } })).status).toBe(401);
    expect((await app.request(`${R}/graphs`, { headers: { ...HOST, cookie: `pg_token=${TEST_TOKEN}` } })).status).toBe(401);
    expect((await app.request("/?t=wrong", { headers: HOST })).status).toBe(401);
  });

  it("rejects other localhost ports once listening (cross-port CSRF) and non-JSON cookie writes", async () => {
    setup.ctx.port = 4777;
    const cookie = { ...HOST, cookie: `pg_token=${sessionCookieValue(TEST_TOKEN)}` };
    const crossPort = { ...cookie, origin: "http://127.0.0.1:3000", "content-type": "text/plain" };
    expect((await app.request(`${R}/runs/x/cancel`, { method: "POST", headers: crossPort, body: "{}" })).status).toBe(403);
    expect((await app.request(`${R}/graphs`, { headers: { ...cookie, host: "127.0.0.1:3000" } })).status).toBe(403);
    expect((await app.request(`${R}/graphs`, { headers: { ...cookie, origin: "http://localhost:4777" } })).status).toBe(200);
    const plain = await app.request(`${R}/runs/x/cancel`, { method: "POST", headers: { ...cookie, "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ code: "forbidden_content_type" });
    const json = await app.request(`${R}/runs/x/cancel`, { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(200);
  });

  it("accepts a node run's hook token on its own hook routes only", async () => {
    const token = hookToken(TEST_HOOK_SECRET, "nr1");
    const headers = { ...HOST, authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.request("/hooks/nr1/stop", { method: "POST", headers, body: "{}" })).status).toBe(204);
    expect((await app.request("/hooks/nr2/stop", { method: "POST", headers, body: "{}" })).status).toBe(401);
    expect((await app.request(`${R}/graphs`, { headers })).status).toBe(401);
    expect((await app.request(`${R}/node-runs/nr1/approval`, { method: "POST", headers, body: '{"approved":true}' })).status).toBe(401);
  });

  it("derives hook tokens from the hook secret, never from the API token", async () => {
    const fromToken = { ...HOST, authorization: `Bearer ${hookToken(TEST_TOKEN, "nr1")}`, "content-type": "application/json" };
    expect((await app.request("/hooks/nr1/stop", { method: "POST", headers: fromToken, body: "{}" })).status).toBe(401);
    const fromSecret = { ...HOST, authorization: `Bearer ${hookToken(TEST_HOOK_SECRET, "nr1")}`, "content-type": "application/json" };
    expect((await app.request("/hooks/nr1/stop", { method: "POST", headers: fromSecret, body: "{}" })).status).toBe(204);
    // The API token itself still works for local clients.
    const bearer = { ...HOST, authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };
    expect((await app.request("/hooks/nr1/stop", { method: "POST", headers: bearer, body: "{}" })).status).toBe(204);
  });
});

describe("graph routes", () => {
  it("saves, lists, reads and deletes graphs", async () => {
    const put = await app.request(`${R}/graphs/demo`, { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(promptGraph("demo")) });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { hash: string; graph: { settings: { maxParallelClaude: number } } };
    expect(saved.graph.settings.maxParallelClaude).toBe(3);

    const list = (await (await app.request(`${R}/graphs`, { headers: AUTH })).json()) as { graphs: Array<{ id: string }> };
    expect(list.graphs.map((g) => g.id)).toEqual(["demo"]);

    const get = (await (await app.request(`${R}/graphs/demo`, { headers: AUTH })).json()) as Record<string, unknown>;
    expect(get).toMatchObject({ hash: saved.hash, modifiedOutside: false, activeRunId: null });

    fs.appendFileSync(path.join(repo, ".promptgraph", "graphs", "demo.json"), "\n");
    const again = (await (await app.request(`${R}/graphs/demo`, { headers: AUTH })).json()) as Record<string, unknown>;
    expect(again.modifiedOutside).toBe(true);

    expect((await app.request(`${R}/graphs/demo`, { method: "DELETE", headers: AUTH })).status).toBe(200);
    const missing = await app.request(`${R}/graphs/demo`, { headers: AUTH });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });

  it("validates bodies", async () => {
    const mismatch = await app.request(`${R}/graphs/other`, { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(promptGraph("demo")) });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: "id_mismatch" });
    const bad = await app.request(`${R}/graphs/demo`, { method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ id: "demo" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "bad_request" });
    const notJson = await app.request(`${R}/graphs/demo`, { method: "PUT", headers: JSON_AUTH, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("returns 409 while the write guard refuses (active run)", async () => {
    (await graphs()).setWriteGuard(() => {
      throw new EngineError("run_active", "active run");
    });
    const res = await app.request(`${R}/graphs/demo`, { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(promptGraph("demo")) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "run_active" });
  });

  it("returns 422 invalid_graph for unparsable files", async () => {
    (await graphs()).ensureDir();
    fs.writeFileSync(path.join(repo, ".promptgraph", "graphs", "broken.json"), "{nope");
    const res = await app.request(`${R}/graphs/broken`, { headers: AUTH });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "invalid_graph" });
  });

  it("validates the stored graph or an unsaved one", async () => {
    (await graphs()).save(createEmptyGraph("empty", "Empty"));
    const stored = (await (await app.request(`${R}/graphs/empty/validate`, { method: "POST", headers: AUTH })).json()) as {
      errors: Array<{ code: string }>;
    };
    expect(stored.errors.map((e) => e.code)).toContain("empty_graph");
    const unsaved = await app.request(`${R}/graphs/empty/validate`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ graph: promptGraph("empty") }),
    });
    expect(await unsaved.json()).toEqual({ errors: [], warnings: [] });
  });

  it("starts runs and maps engine errors", async () => {
    const detail = { run: { id: "r1" }, lanes: [], nodeRuns: [] } as unknown as RunDetail;
    setup.engine.startRun.mockResolvedValueOnce(detail);
    const ok = await app.request(`${R}/graphs/demo/runs`, { method: "POST", headers: JSON_AUTH, body: "{}" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(detail);
    expect(setup.engine.startRun).toHaveBeenCalledWith("demo");

    setup.engine.startRun.mockRejectedValueOnce(new EngineError("validation_failed", "invalid", { errors: [{ code: "x" }], warnings: [] }));
    const bad = await app.request(`${R}/graphs/demo/runs`, { method: "POST", headers: AUTH });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "validation_failed", details: { errors: [{ code: "x" }] } });
  });
});

describe("run and node-run routes", () => {
  it("lists runs, reads, cancels and cleans up", async () => {
    expect(await (await app.request(`${R}/runs?graph=demo&limit=5`, { headers: AUTH })).json()).toEqual({ runs: [] });
    expect((await app.request(`${R}/runs?limit=0`, { headers: AUTH })).status).toBe(400);

    setup.engine.getRun.mockImplementationOnce(() => {
      throw new EngineError("not_found", "Run x not found");
    });
    expect((await app.request(`${R}/runs/x`, { headers: AUTH })).status).toBe(404);

    expect(await (await app.request(`${R}/runs/r1/cancel`, { method: "POST", headers: AUTH })).json()).toEqual({ ok: true });
    expect(setup.engine.cancelRun).toHaveBeenCalledWith("r1");
    setup.engine.cleanupRun.mockRejectedValueOnce(new EngineError("invalid_state", "still running"));
    expect((await app.request(`${R}/runs/r1/cleanup`, { method: "POST", headers: AUTH })).status).toBe(409);
    expect(await (await app.request(`${R}/runs/r1/resume`, { method: "POST", headers: AUTH })).json()).toEqual({ ok: true });
    expect(setup.engine.resumeRun).toHaveBeenCalledWith("r1");
    expect(await (await app.request(`${R}/ptys/reopen-1`, { method: "DELETE", headers: AUTH })).json()).toEqual({ ok: true });
    expect(setup.engine.closeReopenedSession).toHaveBeenCalledWith("reopen-1");
    expect(await (await app.request(`${R}/pending`, { headers: AUTH })).json()).toEqual({ nodeRuns: [] });
  });

  it("forwards manual controls with validated bodies", async () => {
    const nodeRun = { id: "n1" };
    for (const m of ["done", "retry", "skip", "fail", "setHold", "submitApproval"] as const) setup.engine[m].mockResolvedValue(nodeRun);

    for (const action of ["done", "retry", "skip"]) {
      const res = await app.request(`${R}/node-runs/n1/${action}`, { method: "POST", headers: AUTH });
      expect(await res.json()).toEqual({ nodeRun });
    }
    await app.request(`${R}/node-runs/n1/fail`, { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ reason: "nope" }) });
    expect(setup.engine.fail).toHaveBeenCalledWith("n1", "nope");

    expect((await app.request(`${R}/node-runs/n1/hold`, { method: "POST", headers: JSON_AUTH, body: "{}" })).status).toBe(400);
    await app.request(`${R}/node-runs/n1/hold`, { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ hold: true }) });
    expect(setup.engine.setHold).toHaveBeenCalledWith("n1", true);

    await app.request(`${R}/node-runs/n1/approval`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ approved: false, comment: "no" }),
    });
    expect(setup.engine.submitApproval).toHaveBeenCalledWith("n1", { approved: false, comment: "no" });

    setup.engine.getApprovalInfo.mockResolvedValue({ message: "ok?" });
    expect(await (await app.request(`${R}/node-runs/n1/approval`, { headers: AUTH })).json()).toEqual({ message: "ok?" });
    setup.engine.getDiff.mockResolvedValue({ patch: "" });
    expect(await (await app.request(`${R}/node-runs/n1/diff`, { headers: AUTH })).json()).toEqual({ patch: "" });
    setup.engine.reopenSession.mockResolvedValue({ ptyId: "reopen-1" });
    expect(await (await app.request(`${R}/node-runs/n1/reopen`, { method: "POST", headers: AUTH })).json()).toEqual({ ptyId: "reopen-1" });
  });
});

describe("misc routes", () => {
  it("describes the repo and the daemon", async () => {
    const info = await (await app.request(R, { headers: AUTH })).json();
    expect(info).toEqual({ id: repoId, path: repo, name: path.basename(repo), currentBranch: "main", branches: ["main", "dev"] });
    const d = (await (await app.request("/api/daemon", { headers: AUTH })).json()) as { supportedNodeTypes: string[] };
    expect(d).toMatchObject({ pid: process.pid, phase: 2, warnings: ["gh not found: PR nodes will fail"] });
    expect(d.supportedNodeTypes).toContain("condition");
  });

  it("reads and persists app settings without resetting unspecified keys", async () => {
    expect(await (await app.request("/api/settings", { headers: AUTH })).json()).toEqual({ notifications: true });
    const off = await app.request("/api/settings", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ notifications: false }) });
    expect(await off.json()).toEqual({ notifications: false });
    const noop = await app.request("/api/settings", { method: "PUT", headers: JSON_AUTH, body: "{}" });
    expect(await noop.json()).toEqual({ notifications: false });
    expect(JSON.parse(fs.readFileSync(setup.ctx.paths.settingsFile, "utf8"))).toEqual({ notifications: false });
    const bad = await app.request("/api/settings", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ notifications: "yes" }) });
    expect(bad.status).toBe(400);
  });

  it("lists slash commands", async () => {
    fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\nBody");
    const res = (await (await app.request(`${R}/commands`, { headers: AUTH })).json()) as { commands: Array<{ name: string; source: string }> };
    expect(res.commands).toContainEqual(expect.objectContaining({ name: "/ship", source: "project" }));
  });
});

describe("hook receiver", () => {
  it("dispatches known events and always answers 204", async () => {
    const handler = vi.fn();
    setup.ctx.hooks.register("nr1", handler);
    const res = await app.request("/hooks/nr1/session-start", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ session_id: "s1", transcript_path: "/t.jsonl" }),
    });
    expect(res.status).toBe(204);
    expect(handler).toHaveBeenCalledWith({ event: "session-start", payload: { session_id: "s1", transcript_path: "/t.jsonl" } });
    expect((await app.request("/hooks/unknown/stop", { method: "POST", headers: JSON_AUTH, body: "garbage" })).status).toBe(204);
    expect((await app.request("/hooks/nr1/bogus", { method: "POST", headers: JSON_AUTH, body: "{}" })).status).toBe(404);
  });
});

describe("static web assets", () => {
  it("returns a hint page when the web app is not built", async () => {
    const res = await app.request("/", { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm build");
  });

  it("serves files with SPA fallback and keeps /api 404s as JSON", async () => {
    const dist = path.join(root, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
    fs.writeFileSync(path.join(dist, "assets", "main.js"), "console.log(1)");
    fs.writeFileSync(path.join(root, "secret.txt"), "secret");

    const js = await app.request("/assets/main.js", { headers: AUTH });
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await (await app.request("/runs/123", { headers: AUTH })).text()).toBe("<html>app</html>");
    expect((await app.request("/assets/missing.js", { headers: AUTH })).status).toBe(404);
    expect((await app.request("/%2e%2e/secret.txt", { headers: AUTH })).status).toBe(404);
    const api = await app.request("/api/nope", { headers: AUTH });
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ code: "not_found" });
  });
});

describe("daemon and repository routes", () => {
  it("answers hello without credentials, with a proof of the current token", async () => {
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
    const res = await app.request(`/api/daemon/hello?nonce=${nonce}`, { headers: HOST });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pid: process.pid, serverVersion: expect.any(String), proof: helloProof(TEST_TOKEN, nonce) });
    expect((await app.request("/api/daemon/hello", { headers: HOST })).status).toBe(400);
    expect((await app.request("/api/daemon", { headers: HOST })).status).toBe(401);
  });

  it("reads the token per request", async () => {
    daemon.ctx.setToken("rotated-token");
    expect((await app.request(`${R}/graphs`, { headers: AUTH })).status).toBe(401);
    expect((await app.request(`${R}/graphs`, { headers: { ...HOST, authorization: "Bearer rotated-token" } })).status).toBe(200);
  });

  it("registers, lists and removes repositories", async () => {
    const list = (await (await app.request("/api/repos", { headers: AUTH })).json()) as { repos: Array<{ id: string; path: string; active: boolean }> };
    expect(list.repos).toEqual([expect.objectContaining({ id: repoId, path: repo, active: true })]);

    const post = (body: unknown) => app.request("/api/repos", { method: "POST", headers: JSON_AUTH, body: JSON.stringify(body) });
    const relative = await post({ path: "some/dir" });
    expect(relative.status).toBe(422);
    expect(await relative.json()).toMatchObject({ code: "path_not_absolute" });
    const notGit = await post({ path: root });
    expect(notGit.status).toBe(422);
    expect(await notGit.json()).toMatchObject({ code: "not_a_git_repo" });
    const again = await post({ path: path.join(repo, ".") });
    expect(await again.json()).toMatchObject({ id: repoId, path: repo });

    expect((await app.request(`/api/repos/${repoId}`, { method: "DELETE", headers: AUTH })).status).toBe(200);
    const gone = await app.request(`${R}/graphs`, { headers: AUTH });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: "unknown_repo" });
    expect((await app.request(R, { headers: AUTH })).status).toBe(404);
  });

  it("answers 409 repo_unavailable when the directory is gone", async () => {
    const other = createTempRepo("pg-gone-");
    const added = await daemon.ctx.registry.add(other.repo);
    other.cleanup();
    const res = await app.request(`/api/repos/${added.id}/graphs`, { headers: AUTH });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "repo_unavailable" });
    expect(daemon.ctx.registry.summary(added.id)).toMatchObject({ available: false });
  });

  it("removes a repository without loading or activating it: gone, never activated or failing to activate", async () => {
    const remove = (id: string) => app.request(`/api/repos/${id}`, { method: "DELETE", headers: AUTH });

    const gone = createTempRepo("pg-gone-");
    const goneId = (await daemon.ctx.registry.add(gone.repo)).id;
    gone.cleanup();
    expect((await remove(goneId)).status).toBe(200);
    expect(daemon.ctx.registry.summary(goneId)).toBeNull();

    const lazy = createTempRepo("pg-lazy-");
    cleanups.push(lazy.cleanup);
    const lazyId = repoIdFor(lazy.repo);
    daemon.ctx.store.insertRepo({ id: lazyId, path: lazy.repo, name: "lazy", addedAt: 1 });
    expect((await app.request(`/api/repos/${lazyId}`, { headers: AUTH })).status).toBe(200);
    expect((await remove(lazyId)).status).toBe(200);
    expect(fs.existsSync(path.join(lazy.repo, ".promptgraph"))).toBe(false);
    expect(daemon.ctx.registry.summary(lazyId)).toBeNull();

    const broken = createTempRepo("pg-broken-");
    cleanups.push(broken.cleanup);
    // A file where the graphs dir should be: activation fails.
    fs.writeFileSync(path.join(broken.repo, ".promptgraph"), "");
    const brokenId = repoIdFor(broken.repo);
    daemon.ctx.store.insertRepo({ id: brokenId, path: broken.repo, name: "broken", addedAt: 1 });
    const write = await app.request(`/api/repos/${brokenId}/graphs/x/validate`, { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ graph: promptGraph("x") }) });
    expect(write.status).toBe(500);
    expect(await write.json()).toMatchObject({ code: "activation_failed" });
    expect((await remove(brokenId)).status).toBe(200);
    expect(daemon.ctx.registry.summary(brokenId)).toBeNull();
  });

  it("loads a repository on GET without touching it and activates it before a write", async () => {
    const other = createTempRepo("pg-lazy-");
    cleanups.push(other.cleanup);
    const id = repoIdFor(other.repo);
    daemon.ctx.store.insertRepo({ id, path: other.repo, name: "lazy", addedAt: 1 });
    expect(await (await app.request(`/api/repos/${id}/graphs`, { headers: AUTH })).json()).toEqual({ graphs: [] });
    expect(fs.existsSync(path.join(other.repo, ".promptgraph"))).toBe(false);
    expect(daemon.ctx.registry.summary(id)).toMatchObject({ active: false });
    await app.request(`/api/repos/${id}/graphs/x/validate`, { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ graph: promptGraph("x") }) });
    expect(fs.existsSync(path.join(other.repo, ".promptgraph", "graphs"))).toBe(true);
    expect(daemon.ctx.registry.summary(id)).toMatchObject({ active: true });
  });
});
