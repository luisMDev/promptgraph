import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION_FILES, VERSION_PATTERN, readVersions, setVersion } from "../../../scripts/set-version.mjs";

/** DESIGN §20.4: every versioned file carries the same X.Y.Z (scripts/set-version.mjs keeps them in step). */
const repo = path.resolve(import.meta.dirname, "../../..");

describe("versions", () => {
  it("covers the packages, the server constant, Cargo, tauri.conf.json and the Claude Code plugin", () => {
    expect(VERSION_FILES.map((f) => f.file)).toEqual([
      "packages/shared/package.json",
      "packages/server/package.json",
      "packages/web/package.json",
      "packages/desktop/package.json",
      "packages/server/src/config/version.ts",
      "packages/desktop/src-tauri/Cargo.toml",
      "packages/desktop/src-tauri/Cargo.lock",
      "packages/desktop/src-tauri/tauri.conf.json",
      "plugins/promptgraph/.claude-plugin/plugin.json",
    ]);
  });

  it("every file carries the same valid version", () => {
    const versions = readVersions(repo);
    expect(Object.keys(versions)).toHaveLength(VERSION_FILES.length);
    const values = new Set(Object.values(versions));
    expect(values.size, JSON.stringify(versions, null, 2)).toBe(1);
    const [version] = values;
    expect(version).toMatch(VERSION_PATTERN);
    expect(versions["plugins/promptgraph/.claude-plugin/plugin.json"]).toBe(version);
    expect(JSON.parse(fs.readFileSync(path.join(repo, "plugins/promptgraph/.claude-plugin/plugin.json"), "utf8")).version).toBe(version);
  });

  describe("setVersion on a copy", () => {
    let tmp: string | null = null;
    afterEach(() => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    });

    function copy(): string {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-set-version-"));
      for (const { file } of VERSION_FILES) {
        fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
        fs.copyFileSync(path.join(repo, file), path.join(tmp, file));
      }
      return tmp;
    }

    it("sets every file, touches nothing else in them, and is idempotent", () => {
      const root = copy();
      const before = Object.fromEntries(VERSION_FILES.map(({ file }) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
      const original = Object.values(readVersions(root))[0]!;
      expect(setVersion("1.2.3-rc.1", root)).toHaveLength(VERSION_FILES.length);
      expect(new Set(Object.values(readVersions(root)))).toEqual(new Set(["1.2.3-rc.1"]));
      expect(setVersion("1.2.3-rc.1", root)).toEqual([]);
      for (const { file } of VERSION_FILES) {
        const changed = fs.readFileSync(path.join(root, file), "utf8").split("\n");
        const old = before[file]!.split("\n");
        expect(changed.length).toBe(old.length);
        expect(changed.filter((line, i) => line !== old[i])).toHaveLength(1);
      }
      setVersion(original, root);
      for (const { file } of VERSION_FILES) expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(before[file]);
    });

    it("leaves Cargo.lock's other packages and nested JSON versions alone", () => {
      const root = copy();
      setVersion("9.9.9", root);
      const lock = fs.readFileSync(path.join(root, "packages/desktop/src-tauri/Cargo.lock"), "utf8");
      expect(lock.match(/version = "9\.9\.9"/g)).toHaveLength(1);
      expect(lock).toContain('name = "promptgraph-desktop"\nversion = "9.9.9"');
      const cargo = fs.readFileSync(path.join(root, "packages/desktop/src-tauri/Cargo.toml"), "utf8");
      expect(cargo.match(/9\.9\.9/g)).toHaveLength(1);
    });

    it("refuses invalid versions and writes nothing", () => {
      const root = copy();
      const before = readVersions(root);
      for (const bad of ["1.2", "v1.2.3", "1.2.3+build", "01.2.3", "1.2.3-", ""]) {
        expect(() => setVersion(bad, root)).toThrow(/invalid version/);
      }
      expect(readVersions(root)).toEqual(before);
    });

    it.skipIf(process.getuid?.() === 0)("restores the files already written when a later write fails", () => {
      const root = copy();
      const before = Object.fromEntries(VERSION_FILES.map(({ file }) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
      const last = path.join(root, VERSION_FILES[VERSION_FILES.length - 1]!.file);
      const lockedDir = path.dirname(last);
      fs.chmodSync(lockedDir, 0o555);
      try {
        expect(() => setVersion("7.7.7", root)).toThrow(/no file changed/);
      } finally {
        fs.chmodSync(lockedDir, 0o755);
      }
      for (const { file } of VERSION_FILES) expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(before[file]);
      const leftovers = VERSION_FILES.flatMap(({ file }) => fs.readdirSync(path.dirname(path.join(root, file))).filter((n) => n.includes(".set-version-")));
      expect(leftovers).toEqual([]);
    });

    it("keeps each file's mode", () => {
      const root = copy();
      const file = path.join(root, VERSION_FILES[0]!.file);
      fs.chmodSync(file, 0o600);
      setVersion("8.8.8", root);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});
