import fs from "node:fs";
import path from "node:path";
import { createEmptyGraph, type GraphInput, type RunDetail } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "../src/engine/engine.js";
import { hookToken } from "../src/hooks/hook-token.js";
import { createHttpApp } from "../src/http/app.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { createTestContext, TEST_TOKEN } from "./support/http-ctx.js";

vi.mock("../src/git/repo.js", () => ({
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
let setup: ReturnType<typeof createTestContext>;
let app: ReturnType<typeof createHttpApp>;

beforeEach(() => {
  const r = createTempRepo();
  const t = tempDir();
  repo = r.repo;
  root = t.dir;
  cleanups = [r.cleanup, t.cleanup];
  setup = createTestContext(repo, root, { PG_WEB_DIST: path.join(root, "dist"), CLAUDE_CONFIG_DIR: path.join(root, "claude") });
  app = createHttpApp(setup.ctx);
});

afterEach(() => {
  setup.ctx.store.db.close();
  for (const c of cleanups) c();
});

describe("security middleware", () => {
  it("rejects non-localhost Host and Origin (DNS rebinding)", async () => {
    expect((await app.request("/api/graphs", { headers: { ...AUTH, host: "evil.example:4777" } })).status).toBe(403);
    expect((await app.request("/api/graphs", { headers: { ...AUTH, origin: "http://evil.example" } })).status).toBe(403);
    expect((await app.request("/api/graphs", { headers: { ...AUTH, host: "localhost:5173", origin: "http://localhost:5173" } })).status).toBe(200);
  });

  it("requires the token on API, hooks and pages", async () => {
    const res = await app.request("/api/graphs", { headers: HOST });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
    expect((await app.request("/api/graphs", { headers: { ...HOST, authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request("/hooks/x/stop", { method: "POST", headers: HOST, body: "{}" })).status).toBe(401);
    expect((await app.request("/", { headers: HOST })).status).toBe(401);
  });

  it("sets the cookie from ?t= and redirects without it", async () => {
    const res = await app.request(`/runs?x=1&t=${TEST_TOKEN}`, { headers: HOST });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/runs?x=1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`pg_token=${TEST_TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const ok = await app.request("/api/graphs", { headers: { ...HOST, cookie: `pg_token=${TEST_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect((await app.request("/?t=wrong", { headers: HOST })).status).toBe(401);
  });

  it("rejects other localhost ports once listening (cross-port CSRF) and non-JSON cookie writes", async () => {
    setup.ctx.port = 4777;
    const cookie = { ...HOST, cookie: `pg_token=${TEST_TOKEN}` };
    const crossPort = { ...cookie, origin: "http://127.0.0.1:3000", "content-type": "text/plain" };
    expect((await app.request("/api/runs/x/cancel", { method: "POST", headers: crossPort, body: "{}" })).status).toBe(403);
    expect((await app.request("/api/graphs", { headers: { ...cookie, host: "127.0.0.1:3000" } })).status).toBe(403);
    expect((await app.request("/api/graphs", { headers: { ...cookie, origin: "http://localhost:4777" } })).status).toBe(200);
    const plain = await app.request("/api/runs/x/cancel", { method: "POST", headers: { ...cookie, "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ code: "forbidden_content_type" });
    const json = await app.request("/api/runs/x/cancel", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(200);
  });

  it("accepts a node run's hook token on its own hook routes only", async () => {
    const token = hookToken(TEST_TOKEN, "nr1");
    const headers = { ...HOST, authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.request("/hooks/nr1/stop", { method: "POST", headers, body: "{}" })).status).toBe(204);
    expect((await app.request("/hooks/nr2/stop", { method: "POST", headers, body: "{}" })).status).toBe(401);
    expect((await app.request("/api/graphs", { headers })).status).toBe(401);
    expect((await app.request("/api/node-runs/nr1/approval", { method: "POST", headers, body: '{"approved":true}' })).status).toBe(401);
  });
});

describe("graph routes", () => {
  it("saves, lists, reads and deletes graphs", async () => {
    const put = await app.request("/api/graphs/demo", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(promptGraph("demo")) });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { hash: string; graph: { settings: { maxParallelClaude: number } } };
    expect(saved.graph.settings.maxParallelClaude).toBe(3);

    const list = (await (await app.request("/api/graphs", { headers: AUTH })).json()) as { graphs: Array<{ id: string }> };
    expect(list.graphs.map((g) => g.id)).toEqual(["demo"]);

    const get = (await (await app.request("/api/graphs/demo", { headers: AUTH })).json()) as Record<string, unknown>;
    expect(get).toMatchObject({ hash: saved.hash, modifiedOutside: false, activeRunId: null });

    fs.appendFileSync(path.join(repo, ".promptgraph", "graphs", "demo.json"), "\n");
    const again = (await (await app.request("/api/graphs/demo", { headers: AUTH })).json()) as Record<string, unknown>;
    expect(again.modifiedOutside).toBe(true);

    expect((await app.request("/api/graphs/demo", { method: "DELETE", headers: AUTH })).status).toBe(200);
    const missing = await app.request("/api/graphs/demo", { headers: AUTH });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });

  it("validates bodies", async () => {
    const mismatch = await app.request("/api/graphs/other", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(promptGraph("demo")) });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: "id_mismatch" });
    const bad = await app.request("/api/graphs/demo", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify({ id: "demo" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "bad_request" });
    const notJson = await app.request("/api/graphs/demo", { method: "PUT", headers: JSON_AUTH, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("returns 409 while the write guard refuses (active run)", async () => {
    setup.ctx.graphs.setWriteGuard(() => {
      throw new EngineError("run_active", "active run");
    });
    const res = await app.request("/api/graphs/demo", { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(promptGraph("demo")) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "run_active" });
  });

  it("returns 422 invalid_graph for unparsable files", async () => {
    setup.ctx.graphs.ensureDir();
    fs.writeFileSync(path.join(repo, ".promptgraph", "graphs", "broken.json"), "{nope");
    const res = await app.request("/api/graphs/broken", { headers: AUTH });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "invalid_graph" });
  });

  it("validates the stored graph or an unsaved one", async () => {
    setup.ctx.graphs.save(createEmptyGraph("empty", "Empty"));
    const stored = (await (await app.request("/api/graphs/empty/validate", { method: "POST", headers: AUTH })).json()) as {
      errors: Array<{ code: string }>;
    };
    expect(stored.errors.map((e) => e.code)).toContain("empty_graph");
    const unsaved = await app.request("/api/graphs/empty/validate", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ graph: promptGraph("empty") }),
    });
    expect(await unsaved.json()).toEqual({ errors: [], warnings: [] });
  });

  it("starts runs and maps engine errors", async () => {
    const detail = { run: { id: "r1" }, lanes: [], nodeRuns: [] } as unknown as RunDetail;
    setup.engine.startRun.mockResolvedValueOnce(detail);
    const ok = await app.request("/api/graphs/demo/runs", { method: "POST", headers: JSON_AUTH, body: "{}" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(detail);
    expect(setup.engine.startRun).toHaveBeenCalledWith("demo");

    setup.engine.startRun.mockRejectedValueOnce(new EngineError("validation_failed", "invalid", { errors: [{ code: "x" }], warnings: [] }));
    const bad = await app.request("/api/graphs/demo/runs", { method: "POST", headers: AUTH });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "validation_failed", details: { errors: [{ code: "x" }] } });
  });
});

describe("run and node-run routes", () => {
  it("lists runs, reads, cancels and cleans up", async () => {
    expect(await (await app.request("/api/runs?graph=demo&limit=5", { headers: AUTH })).json()).toEqual({ runs: [] });
    expect((await app.request("/api/runs?limit=0", { headers: AUTH })).status).toBe(400);

    setup.engine.getRun.mockImplementationOnce(() => {
      throw new EngineError("not_found", "Run x not found");
    });
    expect((await app.request("/api/runs/x", { headers: AUTH })).status).toBe(404);

    expect(await (await app.request("/api/runs/r1/cancel", { method: "POST", headers: AUTH })).json()).toEqual({ ok: true });
    expect(setup.engine.cancelRun).toHaveBeenCalledWith("r1");
    setup.engine.cleanupRun.mockRejectedValueOnce(new EngineError("invalid_state", "still running"));
    expect((await app.request("/api/runs/r1/cleanup", { method: "POST", headers: AUTH })).status).toBe(409);
    expect(await (await app.request("/api/runs/r1/resume", { method: "POST", headers: AUTH })).json()).toEqual({ ok: true });
    expect(setup.engine.resumeRun).toHaveBeenCalledWith("r1");
    expect(await (await app.request("/api/ptys/reopen-1", { method: "DELETE", headers: AUTH })).json()).toEqual({ ok: true });
    expect(setup.engine.closeReopenedSession).toHaveBeenCalledWith("reopen-1");
    expect(await (await app.request("/api/pending", { headers: AUTH })).json()).toEqual({ nodeRuns: [] });
  });

  it("forwards manual controls with validated bodies", async () => {
    const nodeRun = { id: "n1" };
    for (const m of ["done", "retry", "skip", "fail", "setHold", "submitApproval"] as const) setup.engine[m].mockResolvedValue(nodeRun);

    for (const action of ["done", "retry", "skip"]) {
      const res = await app.request(`/api/node-runs/n1/${action}`, { method: "POST", headers: AUTH });
      expect(await res.json()).toEqual({ nodeRun });
    }
    await app.request("/api/node-runs/n1/fail", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ reason: "nope" }) });
    expect(setup.engine.fail).toHaveBeenCalledWith("n1", "nope");

    expect((await app.request("/api/node-runs/n1/hold", { method: "POST", headers: JSON_AUTH, body: "{}" })).status).toBe(400);
    await app.request("/api/node-runs/n1/hold", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ hold: true }) });
    expect(setup.engine.setHold).toHaveBeenCalledWith("n1", true);

    await app.request("/api/node-runs/n1/approval", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ approved: false, comment: "no" }),
    });
    expect(setup.engine.submitApproval).toHaveBeenCalledWith("n1", { approved: false, comment: "no" });

    setup.engine.getApprovalInfo.mockResolvedValue({ message: "ok?" });
    expect(await (await app.request("/api/node-runs/n1/approval", { headers: AUTH })).json()).toEqual({ message: "ok?" });
    setup.engine.getDiff.mockResolvedValue({ patch: "" });
    expect(await (await app.request("/api/node-runs/n1/diff", { headers: AUTH })).json()).toEqual({ patch: "" });
    setup.engine.reopenSession.mockResolvedValue({ ptyId: "reopen-1" });
    expect(await (await app.request("/api/node-runs/n1/reopen", { method: "POST", headers: AUTH })).json()).toEqual({ ptyId: "reopen-1" });
  });
});

describe("misc routes", () => {
  it("describes the repo", async () => {
    const info = await (await app.request("/api/repo", { headers: AUTH })).json();
    expect(info).toMatchObject({ path: repo, currentBranch: "main", branches: ["main", "dev"], phase: 1, warnings: ["gh not found: PR nodes will fail"] });
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
    const res = (await (await app.request("/api/commands", { headers: AUTH })).json()) as { commands: Array<{ name: string; source: string }> };
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
