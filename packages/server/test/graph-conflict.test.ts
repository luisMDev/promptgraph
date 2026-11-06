import fs from "node:fs";
import path from "node:path";
import { API, GRAPH_CONFLICT_CODE, type GraphInput, type SaveGraphResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../src/http/app.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { createTestDaemon, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

vi.mock("../src/git/repo.js", async (orig) => ({
  ...(await orig<typeof import("../src/git/repo.js")>()),
  currentBranch: vi.fn(async () => "main"),
  listBranches: vi.fn(async () => ["main"]),
}));

const JSON_AUTH = { host: "127.0.0.1:4777", authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };

function graph(id: string, prompt = "Do it"): GraphInput {
  return {
    version: 1,
    id,
    name: "Demo",
    settings: { baseBranch: "main" },
    nodes: [{ id: "a", type: "prompt", label: "Implement", position: { x: 0, y: 0 }, config: { prompt } }],
    edges: [],
  };
}

let repo: string;
let cleanups: Array<() => void>;
let daemon: TestDaemon;
let app: ReturnType<typeof createHttpApp>;
let repoId: string;

beforeEach(async () => {
  const r = createTempRepo();
  const t = tempDir();
  repo = r.repo;
  cleanups = [r.cleanup, t.cleanup];
  daemon = await createTestDaemon({
    root: t.dir,
    repos: [repo],
    mockEngines: true,
    env: { PG_WEB_DIST: path.join(t.dir, "dist"), CLAUDE_CONFIG_DIR: path.join(t.dir, "claude") },
  });
  repoId = daemon.repoIds[0]!;
  app = createHttpApp(daemon.ctx);
});

afterEach(async () => {
  await daemon.close();
  for (const c of cleanups) c();
});

const graphs = async () => (await daemon.repo(repoId)).graphs;

const put = (g: GraphInput, baseHash?: string) =>
  app.request(API.repo(repoId).saveGraph(g.id, baseHash), { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(g) });

describe("PUT /api/repos/:repoId/graphs/:id?baseHash= (optimistic concurrency)", () => {
  it("saves when baseHash matches the current file and returns the new hash", async () => {
    const first = (await (await put(graph("demo"))).json()) as SaveGraphResponse;
    const res = await put(graph("demo", "Changed"), first.hash);
    expect(res.status).toBe(200);
    const second = (await res.json()) as SaveGraphResponse;
    expect(second.hash).not.toBe(first.hash);
    expect(second.graph.nodes[0]!.config).toMatchObject({ prompt: "Changed" });
  });

  it("answers 409 graph_conflict when the file changed since the caller read it", async () => {
    const first = (await (await put(graph("demo"))).json()) as SaveGraphResponse;
    await put(graph("demo", "Edited in the UI")); // no baseHash: the web editor's save
    const res = await put(graph("demo", "Stale edit"), first.hash);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string; details: { currentHash: string } };
    expect(body.code).toBe(GRAPH_CONFLICT_CODE);
    expect(body.error).toMatch(/changed since it was read/);
    expect(body.details.currentHash).toBe((await graphs()).currentHash("demo"));
    // Nothing was written.
    expect((await graphs()).get("demo").graph.nodes[0]!.config).toMatchObject({ prompt: "Edited in the UI" });
  });

  it("detects changes made outside the app and deleted graphs", async () => {
    const first = (await (await put(graph("demo"))).json()) as SaveGraphResponse;
    fs.appendFileSync(path.join(repo, ".promptgraph", "graphs", "demo.json"), "\n");
    expect((await put(graph("demo"), first.hash)).status).toBe(409);

    const missing = await put(graph("gone"), first.hash);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: GRAPH_CONFLICT_CODE, error: expect.stringMatching(/does not exist/) });
    expect((await graphs()).currentHash("gone")).toBeNull();
  });

  it("ignores an empty baseHash and keeps saving without one", async () => {
    await put(graph("demo"));
    const res = await app.request(`${API.repo(repoId).graph("demo")}?baseHash=`, { method: "PUT", headers: JSON_AUTH, body: JSON.stringify(graph("demo", "x")) });
    expect(res.status).toBe(200);
  });
});
