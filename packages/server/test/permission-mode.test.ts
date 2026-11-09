import { describe, expect, it } from "vitest";
import { AppSettingsSchema, GraphDefaultsSchema, PermissionModeSchema, type ClaudeNode, type GraphDefaults } from "@promptgraph/shared";
import { parseStoredAppSettings } from "../src/config/app-settings.js";
import { buildClaudeArgs, toCliPermissionMode } from "../src/runners/claude/args.js";
import { resolveClaudeOptions } from "../src/runners/claude/claude-runner.js";

const defaults: GraphDefaults = GraphDefaultsSchema.parse({});

function node(permissionMode?: ClaudeNode["config"]["permissionMode"]): ClaudeNode {
  return { id: "n1", type: "prompt", label: "Build", position: { x: 0, y: 0 }, config: { prompt: "x", context: "fresh", permissionMode } } as ClaudeNode;
}

describe("permission modes (DESIGN §7.6)", () => {
  it("graphs default to auto, and bypassPermissions is not a graph value", () => {
    expect(defaults.permissionMode).toBe("auto");
    expect(PermissionModeSchema.safeParse("bypassPermissions").success).toBe(false);
    expect(GraphDefaultsSchema.safeParse({ permissionMode: "bypassPermissions" }).success).toBe(false);
  });

  it("the bypass app setting is off by default, also in settings files written before it existed", () => {
    expect(AppSettingsSchema.parse({}).bypassPermissions).toBe(false);
    expect(parseStoredAppSettings({ notifications: false }).bypassPermissions).toBe(false);
    expect(parseStoredAppSettings({ bypassPermissions: "yes" }).bypassPermissions).toBe(false);
    expect(parseStoredAppSettings({ bypassPermissions: true }).bypassPermissions).toBe(true);
  });

  it("without the setting, the node's mode wins over the graph default", () => {
    expect(resolveClaudeOptions(node(), defaults).permissionMode).toBe("auto");
    expect(resolveClaudeOptions(node(), { ...defaults, permissionMode: "acceptEdits" }).permissionMode).toBe("acceptEdits");
    expect(resolveClaudeOptions(node("plan"), defaults).permissionMode).toBe("plan");
  });

  it("the setting replaces the graph default with bypassPermissions; a node's own mode still wins", () => {
    expect(resolveClaudeOptions(node(), { ...defaults, permissionMode: "acceptEdits" }, true).permissionMode).toBe("bypassPermissions");
    expect(resolveClaudeOptions(node("plan"), defaults, true).permissionMode).toBe("plan");
    expect(resolveClaudeOptions(node("manual"), defaults, true).permissionMode).toBe("manual");
  });

  it("maps to Claude Code's --permission-mode values", () => {
    expect(toCliPermissionMode("manual")).toBe("default");
    expect(toCliPermissionMode("auto")).toBe("auto");
    expect(toCliPermissionMode("bypassPermissions")).toBe("bypassPermissions");
    const args = buildClaudeArgs({ message: "m", sessionId: "s1", name: "n", settingsPath: "s.json", permissionMode: "bypassPermissions" });
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
  });
});
