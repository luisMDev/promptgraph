import { describe, expect, it } from "vitest";
import { HookRouter, type HookMessage } from "../src/hooks/hook-router.js";

describe("HookRouter", () => {
  it("validates and dispatches to the registered node run", () => {
    const router = new HookRouter();
    const got: HookMessage[] = [];
    router.register("nr1", (m) => got.push(m));
    expect(router.dispatch("nr1", "activity", { tool_name: "Bash", tool_input: { command: "ls" } })).toBe("ok");
    expect(router.dispatch("nr1", "stop", { session_id: "s", last_assistant_message: "hi", extra: 1 })).toBe("ok");
    expect(got.map((m) => m.event)).toEqual(["activity", "stop"]);
    expect(got[1]!.payload).toMatchObject({ last_assistant_message: "hi", extra: 1 });
  });

  it("reports invalid events, unknown node runs and invalid payloads", () => {
    const router = new HookRouter();
    router.register("nr1", () => undefined);
    expect(router.dispatch("nr1", "bogus", {})).toBe("invalid_event");
    expect(router.dispatch("other", "stop", { session_id: "s" })).toBe("unknown_node_run");
    expect(router.dispatch("nr1", "stop", { nope: true })).toBe("invalid_payload");
  });

  it("replaces registrations, unregisters only its own handler and swallows handler errors", () => {
    const router = new HookRouter();
    const calls: string[] = [];
    const offA = router.register("nr", () => calls.push("a"));
    router.register("nr", () => {
      calls.push("b");
      throw new Error("boom");
    });
    offA();
    expect(router.dispatch("nr", "notification", { message: "x" })).toBe("ok");
    expect(calls).toEqual(["b"]);
  });
});
