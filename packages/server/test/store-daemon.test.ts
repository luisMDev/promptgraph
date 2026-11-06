import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GraphSchema } from "@promptgraph/shared";
import { syncTokenFingerprint, TOKEN_FINGERPRINT_KEY, tokenFingerprint } from "../src/daemon/context.js";
import { Sessions } from "../src/daemon/sessions.js";
import { EventBus } from "../src/events/bus.js";
import { MIGRATIONS } from "../src/store/schema.js";
import { openDatabase, Store } from "../src/store/store.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const graph = GraphSchema.parse({ version: 1, id: "demo", name: "Demo", nodes: [{ id: "a", type: "prompt", config: { prompt: "hi" } }] });

function newStore(now = () => 1000): Store {
  const store = new Store(openDatabase(":memory:"), now);
  cleanups.push(() => store.db.close());
  return store;
}

const tables = (db: Database.Database) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);

/** The daemon migration as the multi-repo branch shipped it at index 3 (before the merge with the chat migration). */
const BRANCH_DAEMON_MIGRATION = `
  CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, added_at INTEGER NOT NULL, last_opened_at INTEGER);
  CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const DAEMON_TABLES = ["repos", "sessions", "meta", "chat_sessions", "runs"];

describe("migrations 3 and 4 (DESIGN §11.2)", () => {
  it("upgrades a version-3 database to 6 with chat sessions, repos, sessions and meta, keeping its runs", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = path.join(t.dir, "state.db");
    const old = new Database(file);
    for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
    old.pragma("user_version = 3");
    old
      .prepare(
        `INSERT INTO runs (id, repo_path, graph_id, graph_name, graph_snapshot, graph_hash, short_id, status, started_at)
         VALUES ('r1', '/repo', 'demo', 'Demo', ?, 'h', 'abcd', 'paused', 5)`,
      )
      .run(JSON.stringify(graph));
    expect(tables(old)).not.toContain("repos");
    old.close();

    const db = openDatabase(file);
    cleanups.push(() => db.close());
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(MIGRATIONS).toHaveLength(6);
    expect(tables(db)).toEqual(expect.arrayContaining(DAEMON_TABLES));
    // §23.2: runs recorded before billing was tracked read as unknown.
    expect(new Store(db).getRun("r1")).toMatchObject({ status: "paused", billingMode: null });
  });

  it.each([
    ["the chat migration (main)", () => MIGRATIONS[3]!],
    ["the daemon migration (multi-repo branch)", () => BRANCH_DAEMON_MIGRATION],
  ])("upgrades a version-4 database created with %s to having every table", (_label, fourth) => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = path.join(t.dir, "state.db");
    const old = new Database(file);
    for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
    old.exec(fourth());
    old.pragma("user_version = 4");
    old.close();

    const db = openDatabase(file);
    cleanups.push(() => db.close());
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(tables(db)).toEqual(expect.arrayContaining(DAEMON_TABLES));
    const store = new Store(db);
    expect(store.insertChatSession({ id: "c1", repoPath: "/repo" }).repoPath).toBe("/repo");
    expect(store.insertRepo({ id: "repo-00000001", path: "/repo", name: "repo", addedAt: 1 }).id).toBe("repo-00000001");
  });
});

describe("Store: repositories, meta and sessions", () => {
  it("repos DAO: insert, lookup by id and path, touch, list in registration order, delete", () => {
    let now = 10;
    const store = newStore(() => now);
    const a = store.insertRepo({ id: "a-00000001", path: "/repo/a", name: "a", addedAt: 2 });
    expect(a).toEqual({ id: "a-00000001", path: "/repo/a", name: "a", addedAt: 2, lastOpenedAt: null });
    store.insertRepo({ id: "b-00000002", path: "/repo/b", name: "b", addedAt: 1, lastOpenedAt: 3 });
    expect(store.listRepos().map((r) => r.id)).toEqual(["b-00000002", "a-00000001"]);
    expect(store.getRepo("a-00000001")?.path).toBe("/repo/a");
    expect(store.getRepoByPath("/repo/b")?.id).toBe("b-00000002");
    expect(store.getRepo("nope")).toBeUndefined();
    expect(store.getRepoByPath("/nope")).toBeUndefined();
    now = 42;
    expect(store.touchRepo("a-00000001")?.lastOpenedAt).toBe(42);
    expect(store.touchRepo("a-00000001", 50)?.lastOpenedAt).toBe(50);
    expect(() => store.insertRepo({ id: "c-00000003", path: "/repo/a", name: "a", addedAt: 3 })).toThrow(/UNIQUE/);
    expect(store.deleteRepo("a-00000001")).toBe(true);
    expect(store.deleteRepo("a-00000001")).toBe(false);
    expect(store.listRepos().map((r) => r.id)).toEqual(["b-00000002"]);
  });

  it("meta: get/set with upsert", () => {
    const store = newStore();
    expect(store.getMeta("repos_backfilled")).toBeUndefined();
    store.setMeta("repos_backfilled", "1");
    store.setMeta("repos_backfilled", "2");
    expect(store.getMeta("repos_backfilled")).toBe("2");
  });

  it("transaction rolls back every write when the function throws", () => {
    const store = newStore();
    expect(() =>
      store.transaction(() => {
        store.setMeta("k", "v");
        store.insertRepo({ id: "a-00000001", path: "/a", name: "a", addedAt: 1 });
        throw new Error("crash before commit");
      }),
    ).toThrow("crash before commit");
    expect(store.getMeta("k")).toBeUndefined();
    expect(store.listRepos()).toEqual([]);
  });

  it("sessions DAO: insert, touch, list newest first, delete by prefix or all, expire", () => {
    const store = newStore();
    const s = (idHash: string, createdAt: number, expiresAt = 100) => ({ idHash, label: "Firefox", createdAt, lastSeenAt: createdAt, expiresAt });
    store.insertSession(s("aaaa1111", 1));
    store.insertSession(s("aaaa2222", 2));
    store.insertSession(s("bbbb3333", 3, 10));
    expect(store.getSession("aaaa1111")).toEqual(s("aaaa1111", 1));
    store.touchSession("aaaa1111", 7, 200);
    expect(store.getSession("aaaa1111")).toMatchObject({ lastSeenAt: 7, expiresAt: 200 });
    expect(store.listSessions().map((r) => r.idHash)).toEqual(["bbbb3333", "aaaa2222", "aaaa1111"]);
    expect(() => store.deleteSessions("")).toThrow(/Invalid session id/);
    expect(() => store.deleteSessions("a%")).toThrow(/Invalid session id/);
    expect(store.deleteSessions("cccc")).toEqual([]);
    expect(store.deleteSessions("aaaa2").sort()).toEqual(["aaaa2222"]);
    expect(store.deleteExpiredSessions(10)).toHaveLength(1);
    expect(store.listSessions().map((r) => r.idHash)).toEqual(["aaaa1111"]);
    store.insertSession(s("cccc4444", 4));
    expect(store.deleteSessions("all").sort()).toEqual(["aaaa1111", "cccc4444"]);
    expect(store.listSessions()).toEqual([]);
  });
});

describe("Store: repository paths and counters", () => {
  it("repoStatusCounts aggregates runs and waiting node runs per repository path", () => {
    const store = newStore();
    const run = (id: string, repoPath: string, startedAt: number, status?: "paused" | "succeeded") => {
      store.insertRun({ id, repoPath, graph, graphHash: "h", shortId: id, startedAt });
      if (status) store.updateRun(id, { status });
    };
    const node = (id: string, runId: string, status: "waiting_approval" | "waiting_input" | "idle" | "running" | "succeeded") =>
      store.insertNodeRun({ id, runId, nodeId: id, iteration: 0, attempt: 0, laneId: "main", status });
    run("a1", "/repo/a", 1);
    run("a2", "/repo/a", 5, "paused");
    run("a3", "/repo/a", 3, "succeeded");
    run("b1", "/repo/b", 2);
    node("n1", "a1", "waiting_approval");
    node("n2", "a1", "waiting_input");
    node("n3", "a2", "idle");
    node("n4", "a2", "running");
    node("n5", "b1", "waiting_approval");
    node("n6", "b1", "waiting_approval");
    node("n7", "b1", "succeeded");

    const counts = store.repoStatusCounts();
    expect(counts.get("/repo/a")).toEqual({ running: 1, paused: 1, approval: 1, input: 2, lastRunAt: 5 });
    expect(counts.get("/repo/b")).toEqual({ running: 1, paused: 0, approval: 2, input: 0, lastRunAt: 2 });
    expect(counts.has("/repo/c")).toBe(false);
    expect(store.distinctRunRepoPaths()).toEqual(["/repo/a", "/repo/b"]);
  });

  it("rewriteRepoPath moves runs, graph meta and chat sessions; the newer graph hash wins on conflict", () => {
    let now = 1;
    const store = newStore(() => now);
    store.insertRun({ id: "r1", repoPath: "/link/a", graph, graphHash: "h", shortId: "r1", startedAt: 1 });
    store.insertRun({ id: "r2", repoPath: "/real/a", graph, graphHash: "h", shortId: "r2", startedAt: 2 });
    store.insertRun({ id: "r3", repoPath: "/other", graph, graphHash: "h", shortId: "r3", startedAt: 3 });
    store.setKnownGraphHash("/link/a", "demo", "old-at-link");
    store.setKnownGraphHash("/link/a", "only-link", "x");
    now = 5;
    store.setKnownGraphHash("/real/a", "demo", "new-at-real");
    now = 2;
    store.setKnownGraphHash("/link/a", "stale", "s-link");
    now = 9;
    store.setKnownGraphHash("/link/a", "fresh", "f-link");
    now = 4;
    store.setKnownGraphHash("/real/a", "stale", "s-real");
    store.setKnownGraphHash("/real/a", "fresh", "f-real");
    store.insertChatSession({ id: "c1", repoPath: "/link/a" });

    expect(store.rewriteRepoPath("/link/a", "/link/a")).toBe(0);
    expect(store.rewriteRepoPath("/link/a", "/real/a")).toBe(1);
    expect(store.getRunRepoPath("r1")).toBe("/real/a");
    expect(store.getRunRepoPath("r3")).toBe("/other");
    expect(store.distinctRunRepoPaths()).toEqual(["/other", "/real/a"]);
    expect(store.getKnownGraphHash("/real/a", "demo")).toBe("new-at-real");
    expect(store.getKnownGraphHash("/real/a", "only-link")).toBe("x");
    expect(store.getKnownGraphHash("/real/a", "stale")).toBe("s-real");
    expect(store.getKnownGraphHash("/real/a", "fresh")).toBe("f-link");
    expect(store.getKnownGraphHash("/link/a", "demo")).toBeUndefined();
    expect(store.repoStatusCounts().get("/real/a")).toMatchObject({ running: 2, lastRunAt: 2 });
    expect(store.listChatSessions("/real/a").map((c) => c.id)).toEqual(["c1"]);
    expect(store.listChatSessions("/link/a")).toEqual([]);
  });
});

describe("syncTokenFingerprint (DESIGN §14)", () => {
  it("keeps sessions under the same token and deletes them all when the token changed", () => {
    const store = newStore();
    const bus = new EventBus();
    const revoked: string[][] = [];
    bus.on("session:revoked", (e) => revoked.push(e.idHashes));
    const sessions = new Sessions(store, bus, () => 1000);
    // No record yet: nothing to keep, the fingerprint is recorded (never the token itself).
    sessions.create("first");
    expect(syncTokenFingerprint(store, sessions, "token-a")).toBe(1);
    expect(store.getMeta(TOKEN_FINGERPRINT_KEY)).toBe(tokenFingerprint("token-a"));
    expect(store.getMeta(TOKEN_FINGERPRINT_KEY)).not.toContain("token-a");

    sessions.create("one");
    sessions.create("two");
    expect(syncTokenFingerprint(store, sessions, "token-a")).toBe(0);
    expect(store.listSessions()).toHaveLength(2);

    // Rotated offline (or replaced by hand): every session goes.
    expect(syncTokenFingerprint(store, sessions, "token-b")).toBe(2);
    expect(store.listSessions()).toEqual([]);
    expect(store.getMeta(TOKEN_FINGERPRINT_KEY)).toBe(tokenFingerprint("token-b"));
    expect(revoked.map((r) => r.length)).toEqual([1, 2]);
  });
});
