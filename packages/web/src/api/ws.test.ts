import { WS_CLOSE_SIGNED_OUT, encodeBase64, type ServerMessage } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient, type WsStatus } from "./ws";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** The server (or the network) closed it. */
  drop(code = 1006) {
    this.close(code);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const last = () => FakeSocket.instances.at(-1)!;

describe("WsClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects to /ws without any credential in the URL", () => {
    vi.stubGlobal("window", { location: { protocol: "http:", host: "127.0.0.1:4777" } });
    new WsClient().connect();
    expect(last().url).toBe("ws://127.0.0.1:4777/ws");
  });

  it("reference-counts run and repository subscriptions", () => {
    const client = new WsClient({ url: () => "ws://test/ws" });
    client.connect();
    last().open();
    const a = client.subscribeRun("r1");
    const b = client.subscribeRun("r1");
    const repo = client.subscribeRepo("demo-0123abcd");
    expect(last().sent).toEqual([
      { type: "subscribe", runId: "r1" },
      { type: "repo:subscribe", repoId: "demo-0123abcd" },
    ]);
    a();
    a(); // idempotent: does not release b's reference
    expect(last().sent).toHaveLength(2);
    b();
    repo();
    expect(last().sent.slice(2)).toEqual([
      { type: "unsubscribe", runId: "r1" },
      { type: "repo:unsubscribe", repoId: "demo-0123abcd" },
    ]);
  });

  it("closes with 4401 → signed out, and never reconnects", async () => {
    const client = new WsClient({ url: () => "ws://test/ws" });
    const states: WsStatus[] = [];
    client.onStatus((s) => states.push(s));
    client.connect();
    last().open();
    last().drop(WS_CLOSE_SIGNED_OUT);
    expect(client.status().signedOut).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    client.connect();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(states.at(-1)?.signedOut).toBe(true);
  });

  it("other closes reconnect forever with backoff ≤ 5 s and restore subscriptions and attachments", async () => {
    const client = new WsClient({ url: () => "ws://test/ws" });
    client.subscribeRepo("demo-0123abcd");
    client.connect();
    last().open();
    expect(last().sent).toEqual([{ type: "repo:subscribe", repoId: "demo-0123abcd" }]);
    client.subscribeRun("r1");
    const detach = client.attachPty("p1", () => undefined);
    last().drop();
    expect(client.status().connection).toBe("reconnecting");
    // Many failed attempts in a row: the delay never exceeds 5 s.
    for (let i = 0; i < 8; i++) {
      const before = FakeSocket.instances.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeSocket.instances.length).toBe(before + 1);
      last().drop();
    }
    await vi.advanceTimersByTimeAsync(5000);
    last().open();
    expect(client.status().connection).toBe("open");
    expect(last().sent).toEqual([
      { type: "repo:subscribe", repoId: "demo-0123abcd" },
      { type: "subscribe", runId: "r1" },
      { type: "pty:attach", ptyId: "p1" },
    ]);
    detach();
    expect(last().sent.at(-1)).toEqual({ type: "pty:detach", ptyId: "p1" });
    client.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(last().readyState).toBe(3);
  });

  it("becomes unreachable after 15 s without a connection, keeps retrying, and recovers", async () => {
    const client = new WsClient({ url: () => "ws://test/ws" });
    client.connect();
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(client.status().connection).toBe("reconnecting");
    last().drop();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.status().connection).toBe("unreachable");
    const attempts = FakeSocket.instances.length;
    last().drop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances.length).toBe(attempts + 1);
    expect(client.status().connection).toBe("unreachable");
    last().open();
    expect(client.status().connection).toBe("open");
  });

  it("a connect that never opens and a 401 probe → signed out", async () => {
    let valid: boolean | null = null;
    const client = new WsClient({ url: () => "ws://test/ws", checkSession: async () => valid });
    client.connect();
    last().drop(); // daemon down: keep retrying
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.instances).toHaveLength(2);
    valid = false; // back up, but this browser's session is gone
    last().drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.status().signedOut).toBe(true);
  });

  it("flags a daemon of another version from hello", () => {
    const client = new WsClient({ url: () => "ws://test/ws", buildVersion: "0.1.0" });
    client.connect();
    last().open();
    last().receive({ type: "hello", version: "0.1.0" });
    expect(client.status()).toMatchObject({ serverVersion: "0.1.0", versionMismatch: false });
    last().receive({ type: "hello", version: "0.2.0" });
    expect(client.status()).toMatchObject({ serverVersion: "0.2.0", versionMismatch: true });

    const unchecked = new WsClient({ url: () => "ws://test/ws", buildVersion: null });
    unchecked.connect();
    last().open();
    last().receive({ type: "hello", version: "9.9.9" });
    expect(unchecked.status().versionMismatch).toBe(false);
  });

  it("decodes pty data for attached listeners and drops invalid frames", () => {
    const client = new WsClient({ url: () => "ws://test/ws" });
    const received: ServerMessage[] = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    const sock = last();
    sock.open();
    const chunks: string[] = [];
    client.attachPty("p1", (b) => chunks.push(new TextDecoder().decode(b)), { cols: 80, rows: 24 });
    expect(sock.sent).toContainEqual({ type: "pty:attach", ptyId: "p1", cols: 80, rows: 24 });

    sock.receive({ type: "pty:data", ptyId: "p1", data: encodeBase64("héllo") });
    sock.receive({ type: "pty:data", ptyId: "other", data: encodeBase64("x") });
    sock.receive({ type: "bogus" });
    expect(chunks).toEqual(["héllo"]);
    expect(received.map((m) => m.type)).toEqual(["pty:data", "pty:data"]);
  });
});
