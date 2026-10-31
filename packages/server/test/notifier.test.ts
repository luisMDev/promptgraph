import { describe, expect, it } from "vitest";
import type { AppSettingsStore } from "../src/config/app-settings.js";
import { EventBus, type BusEvents } from "../src/events/bus.js";
import { attentionText, detectNotifyPlatform, Notifier, psString, sendDesktopNotification, wslToastScript, type NotifyPlatform } from "../src/notify/notifier.js";
import { makeNodeRun } from "./support/runner-ctx.js";

function attention(kind: BusEvents["attention"]["kind"], message: string | null = null): BusEvents["attention"] {
  return { kind, nodeRun: makeNodeRun("nr", "n1"), nodeLabel: "Implement", graphName: "Feature", message };
}

describe("notifications", () => {
  it("detects a platform without throwing", async () => {
    expect(["linux", "wsl", "none"]).toContain(await detectNotifyPlatform());
    expect(["wsl", "none"]).toContain(await detectNotifyPlatform({ PATH: "" }));
  });

  it("never throws when the notifier binary is missing", async () => {
    await expect(sendDesktopNotification("none", "t", "b")).resolves.toBeUndefined();
    await expect(sendDesktopNotification("linux", "t", "b")).resolves.toBeUndefined();
    await expect(sendDesktopNotification("wsl", "t", "b")).resolves.toBeUndefined();
  });

  it("quotes PowerShell strings", () => {
    const script = wslToastScript("it's", "a 'b'");
    expect(script).toContain("CreateTextNode('it''s')");
    expect(script).toContain("CreateTextNode('a ''b''')");
  });

  it("doubles the Unicode single quotes PowerShell also treats as delimiters", () => {
    expect(psString("x\u2019; Start-Process calc; \u2018")).toBe("'x\u2019\u2019; Start-Process calc; \u2018\u2018'");
    expect(psString("\u201A\u201B")).toBe("'\u201A\u201A\u201B\u201B'");
  });

  it("formats titles per attention kind", () => {
    expect(attentionText(attention("waiting_input", "Claude needs your permission"))).toEqual({
      title: "promptgraph: Implement needs your input",
      body: "Feature: Claude needs your permission",
    });
    expect(attentionText(attention("waiting_approval")).title).toContain("waiting for approval");
    expect(attentionText(attention("idle")).body).toBe("Feature: Click Done when it is finished.");
  });

  it("Notifier sends on attention events only while enabled", async () => {
    const bus = new EventBus();
    let enabled = true;
    const settings = { get: () => ({ notifications: enabled }) } as unknown as AppSettingsStore;
    const sent: Array<[NotifyPlatform, string, string]> = [];
    let detections = 0;
    const notifier = new Notifier({
      bus,
      settings,
      detect: async () => (detections++, "linux"),
      send: async (p, t, b) => void sent.push([p, t, b]),
    });
    const stop = notifier.start();
    bus.emit("attention", attention("waiting_input", "hi"));
    await new Promise((r) => setTimeout(r, 10));
    enabled = false;
    bus.emit("attention", attention("idle"));
    await new Promise((r) => setTimeout(r, 10));
    enabled = true;
    stop();
    bus.emit("attention", attention("idle"));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([["linux", "promptgraph: Implement needs your input", "Feature: hi"]]);
    expect(detections).toBe(1);
  });

  it("Notifier swallows settings and sender errors", async () => {
    const bus = new EventBus();
    const settings = { get: () => { throw new Error("broken"); } } as unknown as AppSettingsStore;
    new Notifier({ bus, settings, detect: async () => "linux", send: async () => { throw new Error("x"); } }).start();
    expect(() => bus.emit("attention", attention("idle"))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
