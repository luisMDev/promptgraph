import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { LOGIN_CODE_TTL_MS, SESSION_IDLE_MS } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tokenPath } from "../src/config/token.js";
import { LoginCodes } from "../src/daemon/login-codes.js";
import { SESSION_TOUCH_INTERVAL_MS, sessionHash, sessionLabel, Sessions } from "../src/daemon/sessions.js";
import { hookToken } from "../src/hooks/hook-token.js";
import { createHttpApp } from "../src/http/app.js";
import { SIGNED_OUT_TEXT } from "../src/http/signed-out-page.js";
import { WsHub } from "../src/ws/hub.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { createTestDaemon, sessionCookie, TEST_HOOK_SECRET, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

vi.mock("../src/git/repo.js", async (orig) => ({
  ...(await orig<typeof import("../src/git/repo.js")>()),
  currentBranch: vi.fn(async () => "main"),
  listBranches: vi.fn(async () => ["main"]),
}));

const HOST = { host: "127.0.0.1:4777" };
const BEARER = { ...HOST, authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };

let root: string;
let repo: string;
let cleanups: Array<() => void | Promise<void>>;
let daemon: TestDaemon;
let app: ReturnType<typeof createHttpApp>;
let repoId: string;

beforeEach(async () => {
  const r = createTempRepo();
  const t = tempDir();
  repo = r.repo;
  root = t.dir;
  cleanups = [r.cleanup, t.cleanup];
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.html"), "<!doctype html><title>pg</title>");
  daemon = await createTestDaemon({ root, repos: [repo], mockEngines: true, env: { PG_WEB_DIST: path.join(root, "dist") } });
  repoId = daemon.repoIds[0]!;
  app = createHttpApp(daemon.ctx);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon.close();
  for (const c of cleanups.reverse()) await c();
});

async function mintCode(): Promise<string> {
  const res = await app.request("/api/daemon/login-codes", { method: "POST", headers: BEARER, body: "{}" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string; expiresAt: number };
  expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body.code;
}

const login = (code: string, next = "/r/x", headers: Record<string, string> = {}) =>
  app.request(`/login?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`, { headers: { ...HOST, ...headers } });

function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

async function expectSignedOut(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("set-cookie")).toBeNull();
  const html = await res.text();
  expect(html).not.toContain("<script");
  expect(html.replace(/<[^>]+>/g, "")).toContain(SIGNED_OUT_TEXT.replace(/`/g, ""));
}

describe("login codes", () => {
  it("are 32 random bytes, single use and expire after 30 s", () => {
    let now = 1_000_000;
    const codes = new LoginCodes(() => now);
    const a = codes.mint();
    expect(a.expiresAt).toBe(now + LOGIN_CODE_TTL_MS);
    expect(Buffer.from(a.code, "base64url")).toHaveLength(32);
    expect(codes.redeem(a.code)).toEqual({ desktop: false });
    expect(codes.redeem(a.code)).toBeNull();
    const b = codes.mint(undefined, { desktop: true });
    now += LOGIN_CODE_TTL_MS - 1;
    expect(codes.redeem(b.code)).toEqual({ desktop: true });
    const c = codes.mint();
    now += LOGIN_CODE_TTL_MS;
    expect(codes.redeem(c.code)).toBeNull();
    const d = codes.mint();
    codes.clear();
    expect(codes.redeem(d.code)).toBeNull();
    expect(codes.redeem("")).toBeNull();
    expect(codes.redeem(undefined)).toBeNull();
  });

  it("GET /login redeems a code once and sets the session cookie", async () => {
    const code = await mintCode();
    const res = await login(code, `/r/${repoId}`, { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/r/${repoId}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^pg_session=[A-Za-z0-9_-]{43};/);
    expect(set).toContain("Max-Age=2592000");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).not.toContain(TEST_TOKEN);
    // Only the hash is stored.
    const value = cookieOf(res).slice("pg_session=".length);
    expect(daemon.ctx.store.listSessions()).toEqual([expect.objectContaining({ idHash: sessionHash(value), label: "Firefox" })]);
    expect((await app.request("/api/repos", { headers: { ...HOST, cookie: cookieOf(res) } })).status).toBe(200);
    // Second use: signed out.
    await expectSignedOut(await login(code, `/r/${repoId}`));
    await expectSignedOut(await login("bogus"));
    await expectSignedOut(await app.request("/login", { headers: HOST }));
  });

  it("an expired code gets the signed-out page", async () => {
    const { code, expiresAt } = daemon.ctx.loginCodes.mint();
    vi.spyOn(Date, "now").mockReturnValue(expiresAt);
    await expectSignedOut(await login(code));
    expect(daemon.ctx.store.listSessions()).toEqual([]);
  });

  it("a HEAD request never consumes a code", async () => {
    const code = await mintCode();
    const head = await app.request(`/login?code=${code}`, { method: "HEAD", headers: HOST });
    expect(head.status).toBe(401);
    expect((await login(code)).status).toBe(302);
  });

  // Raw query strings: `next=/%5C%5Cevil` arrives as `/\\evil`.
  it.each(["//evil.example", "/%5C%5Cevil.example", "/%5Cevil.example", "%20/x", "/%09evil", "https://evil.example/", "/..//evil.example", "/%2e%2e//evil.example", ""])(
    "redirects an unsafe next=%s to /",
    async (rawNext) => {
      const res = await app.request(`/login?code=${encodeURIComponent(await mintCode())}&next=${rawNext}`, { headers: HOST });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    },
  );

  it("keeps a literal encoded backslash on the daemon's origin and redirects without next to /", async () => {
    const encoded = await login(await mintCode(), "/%5C%5Cevil.example");
    expect(encoded.headers.get("location")).toBe("/%5C%5Cevil.example");
    expect(new URL(encoded.headers.get("location")!, "http://127.0.0.1:4777").origin).toBe("http://127.0.0.1:4777");
    const none = await app.request(`/login?code=${encodeURIComponent(await mintCode())}`, { headers: HOST });
    expect(none.headers.get("location")).toBe("/");
  });

  it("labels sessions from the user agent or the desktop flag", async () => {
    expect(sessionLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")).toBe("Chrome");
    expect(sessionLabel("Mozilla/5.0 (X11; Linux) AppleWebKit/605.1.15 (KHTML, like Gecko) Tauri/2")).toBe("promptgraph desktop");
    expect(sessionLabel("curl/8.0")).toBe("Browser");
    expect(sessionLabel(undefined, true)).toBe("promptgraph desktop");
    const res = await app.request("/api/daemon/login-codes", { method: "POST", headers: BEARER, body: JSON.stringify({ desktop: true }) });
    const { code } = (await res.json()) as { code: string };
    expect((await login(code, "/", { "user-agent": "Mozilla/5.0 Firefox/140.0" })).status).toBe(302);
    expect(daemon.ctx.store.listSessions()[0]).toMatchObject({ label: "promptgraph desktop" });
  });
});

describe("pages", () => {
  it("an unauthenticated page gets the signed-out page; ?t= is no credential", async () => {
    await expectSignedOut(await app.request("/", { headers: HOST }));
    await expectSignedOut(await app.request(`/r/${repoId}`, { headers: HOST }));
    await expectSignedOut(await app.request(`/?t=${TEST_TOKEN}`, { headers: HOST }));
    await expectSignedOut(await app.request(`/r/${repoId}?t=${encodeURIComponent(TEST_TOKEN)}`, { headers: HOST }));
    // API requests get the JSON 401.
    const api = await app.request(`/api/repos?t=${TEST_TOKEN}`, { headers: HOST });
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ code: "unauthorized" });
  });

  it("an authenticated index.html renews the cookie and is not stored", async () => {
    const cookie = sessionCookie(daemon.ctx);
    const res = await app.request(`/r/${repoId}`, { headers: { ...HOST, cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set.split(";")[0]).toBe(cookie);
    expect(set).toContain("Max-Age=2592000");
    expect(set).toContain("HttpOnly");
    // Bearer page loads and API responses set no cookie.
    expect((await app.request("/", { headers: BEARER })).headers.get("set-cookie")).toBeNull();
    expect((await app.request("/api/repos", { headers: { ...HOST, cookie } })).headers.get("set-cookie")).toBeNull();
  });
});

describe("framing (DESIGN §14)", () => {
  it("every page, asset and API response forbids framing; a framed load is refused", async () => {
    fs.mkdirSync(path.join(root, "dist", "assets"));
    fs.writeFileSync(path.join(root, "dist", "assets", "app.js"), "0");
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx) };
    for (const route of [`/r/${repoId}`, "/assets/app.js", "/api/repos"]) {
      const res = await app.request(route, { headers: cookie });
      expect(res.status, route).toBe(200);
      expect(res.headers.get("x-frame-options"), route).toBe("DENY");
      expect(res.headers.get("content-security-policy"), route).toBe("frame-ancestors 'none'");
    }
    for (const dest of ["iframe", "frame", "embed", "object", "fencedframe"]) {
      const res = await app.request(`/r/${repoId}`, { headers: { ...cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": dest } });
      expect(res.status, dest).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_frame" });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
    // A top-level navigation (the browser tab, the desktop window) is served.
    const top = await app.request(`/r/${repoId}`, { headers: { ...cookie, "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    expect(top.status).toBe(200);
    // The page shown when the web UI is not built forbids framing too.
    fs.rmSync(path.join(root, "dist", "index.html"));
    const notBuilt = await app.request("/", { headers: cookie });
    expect(notBuilt.status).toBe(503);
    expect(notBuilt.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("Bearer-only routes", () => {
  it("refuse cookie-only requests with 403 forbidden_cookie_auth", async () => {
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx), "content-type": "application/json" };
    const routes: Array<[string, string]> = [
      ["POST", "/api/daemon/login-codes"],
      ["POST", "/api/daemon/token/rotate"],
      ["GET", "/api/daemon/sessions"],
      ["DELETE", "/api/daemon/sessions/all"],
    ];
    for (const [method, route] of routes) {
      const res = await app.request(route, { method, headers: cookie, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${route}`).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_cookie_auth" });
    }
    expect(daemon.ctx.getToken()).toBe(TEST_TOKEN);
    expect(daemon.ctx.store.listSessions()).toHaveLength(1);
  });

  it("are judged on the decoded path the router matches (percent-encoded variants)", async () => {
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx), "content-type": "application/json" };
    const routes: Array<[string, string]> = [
      ["POST", "/api/daemon/login%2Dcodes"],
      ["POST", "/api/daemon/login-code%73"],
      ["POST", "/api/daemon/token/rot%61te"],
      ["GET", "/api/daemon/session%73"],
      ["DELETE", "/api/daemon/session%73/all"],
      ["GET", "/ap%69/daemon/sessions"],
    ];
    for (const [method, route] of routes) {
      const res = await app.request(route, { method, headers: cookie, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${route}`).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_cookie_auth" });
    }
    expect(daemon.ctx.getToken()).toBe(TEST_TOKEN);
    expect(daemon.ctx.store.listSessions()).toHaveLength(1);
    // The hook receiver takes no cookie, also behind an encoded prefix.
    const hook = await app.request("/hook%73/nr1/stop", { method: "POST", headers: cookie, body: "{}" });
    expect(hook.status).toBe(401);
  });

  it("list and revoke sessions over Bearer", async () => {
    const one = sessionCookie(daemon.ctx, "one");
    const two = sessionCookie(daemon.ctx, "two");
    const listed = await app.request("/api/daemon/sessions", { headers: { ...BEARER, cookie: two } });
    const { sessions } = (await listed.json()) as { sessions: Array<{ id: string; label: string; current: boolean }> };
    expect(sessions.map((s) => [s.label, s.current]).sort()).toEqual([
      ["one", false],
      ["two", true],
    ]);
    const idOne = sessions.find((s) => s.label === "one")!.id;
    expect(idOne).toMatch(/^[0-9a-f]{8}$/);
    expect((await app.request("/api/daemon/sessions/abc", { method: "DELETE", headers: BEARER })).status).toBe(400);
    const revoked = await app.request(`/api/daemon/sessions/${idOne}`, { method: "DELETE", headers: BEARER });
    expect(await revoked.json()).toEqual({ ok: true, revoked: 1 });
    expect((await app.request("/api/repos", { headers: { ...HOST, cookie: one } })).status).toBe(401);
    expect((await app.request("/api/repos", { headers: { ...HOST, cookie: two } })).status).toBe(200);
    expect(await (await app.request("/api/daemon/sessions/all", { method: "DELETE", headers: BEARER })).json()).toEqual({ ok: true, revoked: 1 });
    expect((await app.request("/api/repos", { headers: { ...HOST, cookie: two } })).status).toBe(401);
  });
});

describe("Fetch Metadata", () => {
  it("refuses cross-site and no-cors/navigate cookie API requests", async () => {
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx) };
    const variants: Array<Record<string, string>> = [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-mode": "no-cors" }, { "sec-fetch-mode": "navigate" }];
    for (const extra of variants) {
      const res = await app.request("/api/repos", { headers: { ...cookie, ...extra } });
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_cross_site" });
    }
    expect((await app.request("/api/repos", { headers: { ...cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } })).status).toBe(200);
    expect((await app.request("/api/repos", { headers: { ...cookie, "sec-fetch-site": "none" } })).status).toBe(200);
    // No Sec-Fetch-* and no Origin: a non-browser client.
    expect((await app.request("/api/repos", { headers: cookie })).status).toBe(200);
    // Pages and assets are served to any navigation.
    expect((await app.request("/", { headers: { ...cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" } })).status).toBe(200);
    // Bearer requests are not checked.
    expect((await app.request("/api/repos", { headers: { ...BEARER, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status).toBe(200);
  });

  it("applies to percent-encoded API paths too", async () => {
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx) };
    for (const route of ["/ap%69/repos", "/%61pi/repos", "/api/rep%6Fs"]) {
      const res = await app.request(route, { headers: { ...cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" } });
      expect(res.status, route).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_cross_site" });
    }
    const plain = await app.request("/ap%69/settings", { method: "PUT", headers: { ...cookie, "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ code: "forbidden_content_type" });
  });

  it("cookie API writes need application/json", async () => {
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx) };
    const plain = await app.request("/api/settings", { method: "PUT", headers: { ...cookie, "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ code: "forbidden_content_type" });
    expect((await app.request("/api/settings", { method: "PUT", headers: { ...cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  });

  it("a cookie GET under /api/repos/<id> never activates the repository", async () => {
    // A second daemon over the same PG_HOME: the repository is registered but not active.
    await daemon.close();
    daemon = await createTestDaemon({ root, mockEngines: true, env: { PG_WEB_DIST: path.join(root, "dist") } });
    app = createHttpApp(daemon.ctx);
    expect(daemon.ctx.registry.summary(repoId)).toMatchObject({ active: false });
    const cookie = { ...HOST, cookie: sessionCookie(daemon.ctx) };
    expect((await app.request(`/api/repos/${repoId}`, { headers: cookie })).status).toBe(200);
    expect((await app.request(`/api/repos/${repoId}/graphs`, { headers: cookie })).status).toBe(200);
    expect((await app.request(`/api/repos/${repoId}/runs`, { headers: cookie })).status).toBe(200);
    expect(daemon.ctx.registry.summary(repoId)).toMatchObject({ active: false });
    const write = await app.request(`/api/repos/${repoId}/graphs/g/validate`, { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: "{}" });
    expect(write.status).not.toBe(403);
    expect(daemon.ctx.registry.summary(repoId)).toMatchObject({ active: true });
  });
});

describe("sessions", () => {
  it("slide their expiry and write last_seen_at at most once an hour", () => {
    const t0 = 5_000_000;
    const sessions = new Sessions(daemon.ctx.store, daemon.ctx.bus, () => t0);
    const value = sessions.create("Firefox", t0);
    const hash = sessionHash(value);
    expect(daemon.ctx.store.getSession(hash)).toMatchObject({ createdAt: t0, lastSeenAt: t0, expiresAt: t0 + SESSION_IDLE_MS });
    const touch = vi.spyOn(daemon.ctx.store, "touchSession");
    expect(sessions.verify(value, t0 + SESSION_TOUCH_INTERVAL_MS - 1)).toMatchObject({ lastSeenAt: t0 });
    expect(touch).not.toHaveBeenCalled();
    const t1 = t0 + SESSION_TOUCH_INTERVAL_MS;
    expect(sessions.verify(value, t1)).toMatchObject({ lastSeenAt: t1, expiresAt: t1 + SESSION_IDLE_MS });
    expect(touch).toHaveBeenCalledTimes(1);
    expect(daemon.ctx.store.getSession(hash)).toMatchObject({ lastSeenAt: t1, expiresAt: t1 + SESSION_IDLE_MS });
    sessions.verify(value, t1 + 60_000);
    expect(touch).toHaveBeenCalledTimes(1);
    // Used 29 days later: still valid, and moved again.
    const t2 = t1 + SESSION_IDLE_MS - 1;
    expect(sessions.verify(value, t2)).toMatchObject({ expiresAt: t2 + SESSION_IDLE_MS });
    // Idle for 30 days: expired and deleted.
    const revoked = vi.fn();
    daemon.ctx.bus.on("session:revoked", revoked);
    expect(sessions.verify(value, t2 + SESSION_IDLE_MS)).toBeNull();
    expect(daemon.ctx.store.getSession(hash)).toBeUndefined();
    expect(revoked).toHaveBeenCalledWith({ idHashes: [hash] });
    expect(sessions.verify("x".repeat(43), t0)).toBeNull();
    expect(sessions.verify("short", t0)).toBeNull();
    expect(sessions.verify(null, t0)).toBeNull();
  });

  it("expired sessions are deleted when the daemon starts", async () => {
    const t0 = Date.now() - SESSION_IDLE_MS - 1000;
    new Sessions(daemon.ctx.store, daemon.ctx.bus).create("old", t0);
    const live = sessionCookie(daemon.ctx, "live");
    await daemon.close();
    daemon = await createTestDaemon({ root, mockEngines: true });
    expect(daemon.ctx.store.listSessions().map((s) => s.label)).toEqual(["live"]);
    expect(daemon.ctx.sessions.verify(live.slice("pg_session=".length))).not.toBeNull();
  });

  it("an expired session dropped by list() closes its sockets with 4401", async () => {
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    const hub = new WsHub(daemon.ctx);
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    daemon.ctx.port = port;
    const open = (cookie: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
        ws.once("open", () => resolve(ws));
        ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      });
    const old = await open(sessionCookie(daemon.ctx, "old"));
    const closed = new Promise<number>((resolve) => old.once("close", (code) => resolve(code)));
    const revoked = vi.fn();
    daemon.ctx.bus.on("session:revoked", revoked);
    // 30 idle days later the WebSocket has never touched the session; listing drops it.
    expect(daemon.ctx.sessions.list(null, Date.now() + SESSION_IDLE_MS + 1000)).toEqual([]);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(await closed).toBe(4401);
  });

  it("revoke takes an 8+ hex prefix or all and emits session:revoked", () => {
    const { sessions, bus } = daemon.ctx;
    const a = sessionHash(sessions.create("a"));
    sessions.create("b");
    const revoked = vi.fn();
    bus.on("session:revoked", revoked);
    expect(() => sessions.revoke("abc")).toThrow(/at least 8 hex digits/);
    expect(() => sessions.revoke("zzzzzzzz")).toThrow();
    expect(sessions.revoke(a.slice(0, 8).toUpperCase())).toBe(1);
    expect(revoked).toHaveBeenCalledWith({ idHashes: [a] });
    expect(sessions.revokeAll()).toBe(1);
    expect(sessions.revokeAll()).toBe(0);
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it("the sweep drops sessions that expired without a request and emits session:revoked", () => {
    vi.useFakeTimers();
    try {
      let now = Date.now();
      const sessions = new Sessions(daemon.ctx.store, daemon.ctx.bus, () => now);
      const hash = sessionHash(sessions.create("idle"));
      const revoked = vi.fn();
      daemon.ctx.bus.on("session:revoked", revoked);
      const stop = sessions.startSweep(1000);
      vi.advanceTimersByTime(1000);
      expect(revoked).not.toHaveBeenCalled();
      now += SESSION_IDLE_MS + 1;
      vi.advanceTimersByTime(1000);
      expect(revoked).toHaveBeenCalledWith({ idHashes: [hash] });
      stop();
      sessions.create("later");
      now += SESSION_IDLE_MS + 1;
      vi.advanceTimersByTime(5000);
      expect(revoked).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("token rotation", () => {
  it("invalidates the old Bearer and every cookie, closes every socket and keeps hook tokens", async () => {
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    const hub = new WsHub(daemon.ctx);
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    daemon.ctx.port = port;
    const base = `http://127.0.0.1:${port}`;
    const cookie = sessionCookie(daemon.ctx);
    const hookHeader = { authorization: `Bearer ${hookToken(TEST_HOOK_SECRET, "nr1")}`, "content-type": "application/json" };
    const open = (headers: Record<string, string>) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
        ws.once("open", () => resolve(ws));
        ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      });
    const sockets = [await open({ authorization: `Bearer ${TEST_TOKEN}` }), await open({ cookie })];
    const closes = sockets.map((ws) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code))));
    const code = daemon.ctx.loginCodes.mint().code;

    const rotated = await fetch(`${base}/api/daemon/token/rotate`, { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(await rotated.json()).toEqual({ ok: true });
    expect(await Promise.all(closes)).toEqual([4401, 4401]);

    const fresh = daemon.ctx.getToken();
    expect(fresh).not.toBe(TEST_TOKEN);
    expect(fs.readFileSync(tokenPath(daemon.ctx.paths), "utf8").trim()).toBe(fresh);
    expect(fs.statSync(tokenPath(daemon.ctx.paths)).mode & 0o777).toBe(0o600);
    expect((await fetch(`${base}/api/repos`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/repos`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/repos`, { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(200);
    await expect(open({ authorization: `Bearer ${TEST_TOKEN}` })).rejects.toThrow("HTTP 401");
    await expect(open({ cookie })).rejects.toThrow("HTTP 401");
    expect(daemon.ctx.store.listSessions()).toEqual([]);
    // Outstanding login codes are dropped.
    expect((await fetch(`${base}/login?code=${code}`, { redirect: "manual" })).status).toBe(401);
    // A hook token minted before the rotation still reaches its hook route.
    expect((await fetch(`${base}/hooks/nr1/stop`, { method: "POST", headers: hookHeader, body: "{}" })).status).toBe(204);
  });
});
