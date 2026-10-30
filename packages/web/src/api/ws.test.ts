import { encodeBase64, type ServerMessage } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./ws";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

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

  it("decodes pty data for attached listeners and drops invalid frames", () => {
    const client = new WsClient(() => "ws://test/ws");
    const received: ServerMessage[] = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    const sock = FakeSocket.instances[0]!;
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

  it("reconnects with backoff and restores subscriptions and attachments", () => {
    const client = new WsClient(() => "ws://test/ws");
    client.connect();
    FakeSocket.instances[0]!.open();
    client.subscribeRun("r1");
    const detach = client.attachPty("p1", () => undefined);
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(500);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual([
      { type: "subscribe", runId: "r1" },
      { type: "pty:attach", ptyId: "p1" },
    ]);
    detach();
    expect(second.sent.at(-1)).toEqual({ type: "pty:detach", ptyId: "p1" });
    client.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
