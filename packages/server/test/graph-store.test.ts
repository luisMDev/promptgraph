import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyGraph, GraphSchema } from "@promptgraph/shared";
import { graphsDir } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { GraphLoadError, GraphNotFoundError, GraphStore, hashContent, serializeGraph } from "../src/graphs/graph-store.js";
import { tempDir, waitFor } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const bus = new EventBus();
  const changed: string[] = [];
  bus.on("graphs:changed", (e) => changed.push(e.graphId));
  const store = new GraphStore(t.dir, bus);
  return { repo: t.dir, dir: graphsDir(t.dir), store, changed };
}

const sample = () =>
  GraphSchema.parse({
    version: 1,
    id: "demo",
    name: "Demo",
    nodes: [{ id: "a", type: "prompt", config: { prompt: "Reply with PONG" } }],
  });

describe("hashContent / serializeGraph", () => {
  it("hashes bytes with sha256", () => {
    expect(hashContent("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashContent(Buffer.from("abc"))).toBe(hashContent("abc"));
  });

  it("serialises in schema key order regardless of input order, with a trailing newline", () => {
    const g = sample();
    const shuffled = { nodes: g.nodes, edges: g.edges, settings: g.settings, name: g.name, id: g.id, version: g.version } as typeof g;
    const text = serializeGraph(shuffled);
    expect(text).toBe(serializeGraph(g));
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["version", "id", "name", "settings", "nodes", "edges"]);
  });
});

describe("GraphStore", () => {
  it("saves atomically, loads with defaults and a content hash, and emits graphs:changed", () => {
    const { store, dir, changed } = setup();
    const saved = store.save(sample());
    const file = path.join(dir, "demo.json");
    expect(fs.readFileSync(file, "utf8")).toBe(serializeGraph(sample()));
    expect(saved.hash).toBe(hashContent(fs.readFileSync(file)));
    expect(fs.readdirSync(dir)).toEqual(["demo.json"]); // no tmp files left
    expect(changed).toEqual(["demo"]);

    const loaded = store.get("demo");
    expect(loaded.graph).toEqual(sample());
    expect(loaded.hash).toBe(saved.hash);
    expect(loaded.graph.settings.maxParallelClaude).toBe(3);
  });

  it("lists valid and invalid files, reporting load errors", () => {
    const { store, dir } = setup();
    store.save(sample());
    store.save(createEmptyGraph("alpha", "Alpha"));
    fs.writeFileSync(path.join(dir, "broken.json"), "{ nope");
    fs.writeFileSync(path.join(dir, "bad-schema.json"), JSON.stringify({ version: 2, id: "bad-schema" }));
    fs.writeFileSync(path.join(dir, "Wrong Name.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");

    const list = store.list();
    expect(list.map((g) => g.id)).toEqual(["Wrong Name", "alpha", "bad-schema", "broken", "demo"]);
    const byId = new Map(list.map((g) => [g.id, g]));
    expect(byId.get("demo")).toMatchObject({ name: "Demo", loadError: null });
    expect(byId.get("broken")).toMatchObject({ name: null, loadError: expect.stringContaining("Invalid JSON") });
    expect(byId.get("bad-schema")!.loadError).toBeTruthy();
    expect(byId.get("Wrong Name")!.loadError).toContain("Invalid file name");
    expect(byId.get("broken")!.hash).toBe(hashContent("{ nope"));
  });

  it("throws GraphLoadError for invalid content and an id/file-name mismatch", () => {
    const { store, dir } = setup();
    store.ensureDir();
    fs.writeFileSync(path.join(dir, "broken.json"), "[");
    expect(() => store.get("broken")).toThrow(GraphLoadError);
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ version: 1, id: "bad", name: "" }));
    try {
      store.get("bad");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraphLoadError);
      expect((err as GraphLoadError).details).toBeInstanceOf(Array);
    }
    fs.writeFileSync(path.join(dir, "other.json"), serializeGraph(sample()));
    expect(() => store.get("other")).toThrow(/does not match/);
  });

  it("rejects unknown and path-traversal ids as not found", () => {
    const { store, repo } = setup();
    store.ensureDir();
    fs.writeFileSync(path.join(repo, "secret.json"), "{}");
    expect(() => store.get("missing")).toThrow(GraphNotFoundError);
    expect(() => store.get("../../secret")).toThrow(GraphNotFoundError);
    expect(() => store.delete("missing")).toThrow(GraphNotFoundError);
  });

  it("rejects invalid graphs on save", () => {
    const { store } = setup();
    expect(() => store.save({ ...sample(), id: "Bad Id" })).toThrow();
    expect(store.list()).toEqual([]);
  });

  it("deletes graphs", () => {
    const { store, changed } = setup();
    store.save(sample());
    store.delete("demo");
    expect(store.list()).toEqual([]);
    expect(changed).toEqual(["demo", "demo"]);
  });

  it("consults the write guard before save and delete", () => {
    const { store } = setup();
    store.save(sample());
    store.setWriteGuard((id) => {
      throw new Error(`locked ${id}`);
    });
    expect(() => store.save(sample())).toThrow("locked demo");
    expect(() => store.delete("demo")).toThrow("locked demo");
    store.setWriteGuard(null);
    store.delete("demo");
  });

  it("watch() reports external changes but not its own writes", async () => {
    const { store, dir, changed } = setup();
    const stop = store.watch();
    cleanups.push(stop);
    store.save(sample());
    await new Promise((r) => setTimeout(r, 250));
    expect(changed).toEqual(["demo"]);

    fs.writeFileSync(path.join(dir, "demo.json"), serializeGraph({ ...sample(), name: "Edited outside" }));
    await waitFor(() => changed.length === 2, 3000);
    expect(changed).toEqual(["demo", "demo"]);
  });
});
