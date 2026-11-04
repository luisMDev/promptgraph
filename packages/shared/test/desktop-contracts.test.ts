import { describe, expect, it } from "vitest";
import {
  compareVersions,
  DESKTOP_DIALOGS,
  DESKTOP_STRIPPED_ENV,
  DESKTOP_STRIPPED_ENV_PREFIXES,
  DesktopInstallResultSchema,
  DesktopPrefsSchema,
  OpenMismatchResultSchema,
  RuntimeManifestSchema,
  ShimResultSchema,
  type ShimStatus,
} from "../src/index.js";

const shim: ShimStatus = {
  path: "/home/u/.local/bin/promptgraph",
  state: "absent",
  foreignTarget: null,
  decision: null,
  onPath: null,
  shadowedBy: null,
  pathHint: null,
  warn: false,
};

describe("desktop distribution contracts (DESIGN §20.6–§20.9)", () => {
  it("compareVersions: numeric major.minor.patch, a pre-release before its release", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBe(1);
    expect(compareVersions("1.2.3-alpha", "1.2.3-beta")).toBe(-1);
    expect(compareVersions("1.2.3-rc.2", "1.2.3-rc.10")).toBe(-1);
    expect(compareVersions("1.2.3-rc", "1.2.3-rc.1")).toBe(-1);
    expect(compareVersions("9.9.9-test", "0.1.0")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0+build.5")).toBe(0);
    // Unparsable versions sort after every parsable one.
    expect(compareVersions("dev", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "dev")).toBe(-1);
  });

  it("the stripped variables include the desktop-only ones and GObject introspection", () => {
    expect(DESKTOP_STRIPPED_ENV).toContain("PG_DESKTOP_AUTO_ANSWER");
    expect(DESKTOP_STRIPPED_ENV).toContain("PG_DESKTOP_UPDATES");
    expect(DESKTOP_STRIPPED_ENV_PREFIXES).toContain("GI_");
  });

  it("parses the CLI's JSON lines", () => {
    expect(OpenMismatchResultSchema.parse({ v: 1, mismatch: { serverVersion: "0.1.0", cliVersion: "0.2.0", runningRuns: null, daemonIsOlder: true } })).toBeTruthy();
    expect(OpenMismatchResultSchema.safeParse({ v: 1, mismatch: { serverVersion: "0.1.0", cliVersion: "0.2.0", runningRuns: -1, daemonIsOlder: true } }).success).toBe(false);
    const buildId = "a".repeat(64);
    expect(RuntimeManifestSchema.parse({ v: 1, version: "0.2.0", nodeVersion: "24.22.2", platform: "linux-x64", buildId })).toBeTruthy();
    expect(RuntimeManifestSchema.safeParse({ v: 1, version: "0.2.0", nodeVersion: "24.22.2", platform: "linux-arm64", buildId }).success).toBe(false);
    expect(RuntimeManifestSchema.safeParse({ v: 1, version: "0.2.0", nodeVersion: "24.22.2", platform: "linux-x64", buildId: "A".repeat(64) }).success).toBe(false);
    expect(
      DesktopInstallResultSchema.parse({ v: 1, version: "0.2.0", root: "/r/0.2.0-aaaaaaaa", cliPath: "/r/0.2.0-aaaaaaaa/bin/promptgraph", current: "0.2.0-aaaaaaaa", installed: true, pruned: [], shim }),
    ).toBeTruthy();
    expect(ShimResultSchema.parse({ v: 1, shim, backup: null })).toBeTruthy();
  });

  it("prefs keep unknown keys", () => {
    const prefs = DesktopPrefsSchema.parse({ v: 1, shim: { decision: "accepted", decidedAt: 1, pathOk: false, warnedVersion: "0.2.0" }, window: { w: 1 } });
    expect(prefs).toMatchObject({ window: { w: 1 } });
    expect(DesktopPrefsSchema.safeParse({ v: 1, shim: { decision: "maybe", decidedAt: 1 } }).success).toBe(false);
  });

  it("every dialog has at least one button key", () => {
    for (const [id, keys] of Object.entries(DESKTOP_DIALOGS)) expect(keys.length, id).toBeGreaterThan(0);
    expect(DESKTOP_DIALOGS["version-mismatch"]).toEqual(["restart", "keep", "use"]);
  });
});
