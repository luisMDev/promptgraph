import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManifestSchema } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STAGE,
  DEPLOY_ARGS,
  LAUNCHER,
  NODE_SHA256,
  NODE_TARBALL,
  NODE_VERSION,
  PRUNE_PATHS,
  SIZE_BUDGET_BYTES,
  assertNoSymlinks,
  assertPtyBuilt,
  assertSafeStage,
  assertWithinBudget,
  computeBuildId,
  nodeUrl,
  obtainTarball,
  pruneTree,
  treeSize,
  verifySha256,
  writeManifest,
} from "../scripts/prepare-runtime.mjs";

/** DESIGN §20.6: the helpers of scripts/prepare-runtime.mjs on fixture trees in temp dirs (no network). */
let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-prepare-runtime-")));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function write(rel: string, content = "x", mode = 0o644): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
  return file;
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

describe("pinned Node", () => {
  it("is v24.22.2 with the hash of its SHASUMS256.txt, over https", () => {
    expect(NODE_VERSION).toBe("24.22.2");
    expect(NODE_SHA256).toBe("48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75");
    expect(NODE_TARBALL).toBe("node-v24.22.2-linux-x64.tar.xz");
    expect(nodeUrl()).toBe("https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz");
  });
});

describe("DEPLOY_ARGS", () => {
  it("deploys from the lockfile (frozen, not --legacy), production only, hoisted, as real copies", () => {
    const args = DEPLOY_ARGS("/stage/server");
    expect(args).toEqual(expect.arrayContaining(["deploy", "--prod", "--frozen-lockfile", "--config.inject-workspace-packages=true", "--config.node-linker=hoisted", "--config.package-import-method=copy"]));
    expect(args).not.toContain("--legacy");
    expect(args.slice(0, 2)).toEqual(["--filter", "@promptgraph/server"]);
    expect(args.at(-1)).toBe("/stage/server");
  });
});

describe("verifySha256 / obtainTarball", () => {
  it("accepts a matching file and keeps it", () => {
    const file = write("a.tar.xz", "good");
    verifySha256(file, sha("good"));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("deletes the file and throws on a mismatch", () => {
    const file = write("a.tar.xz", "evil");
    expect(() => verifySha256(file, sha("good"))).toThrow(/SHA-256 mismatch/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("verifies a fresh download", async () => {
    const cache = path.join(tmp, "cache");
    const download = vi.fn(async (_url: string, dest: string) => fs.writeFileSync(dest, "good"));
    const file = await obtainTarball(cache, { url: "https://example.invalid/dist/n.tar.xz", expected: sha("good"), download });
    expect(download).toHaveBeenCalledOnce();
    expect(file).toBe(path.join(cache, "n.tar.xz"));
  });

  it("rejects and deletes a download that does not match", async () => {
    const cache = path.join(tmp, "cache");
    const download = async (_url: string, dest: string) => fs.writeFileSync(dest, "tampered");
    await expect(obtainTarball(cache, { url: "https://example.invalid/n.tar.xz", expected: sha("good"), download })).rejects.toThrow(/mismatch/);
    expect(fs.existsSync(path.join(cache, "n.tar.xz"))).toBe(false);
  });

  it("re-verifies a cache hit without downloading, and detects a corrupted cached tarball", async () => {
    const cache = path.join(tmp, "cache");
    const download = vi.fn(async (_url: string, dest: string) => fs.writeFileSync(dest, "good"));
    const opts = { url: "https://example.invalid/n.tar.xz", expected: sha("good"), download };
    await obtainTarball(cache, opts);
    await obtainTarball(cache, opts);
    expect(download).toHaveBeenCalledOnce();
    const logged = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes("cache hit") && l.includes("re-verifying"))).toBe(true);

    fs.appendFileSync(path.join(cache, "n.tar.xz"), "flipped");
    await expect(obtainTarball(cache, opts)).rejects.toThrow(/mismatch/);
    expect(download).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(cache, "n.tar.xz"))).toBe(false);
  });
});

describe("pruneTree", () => {
  function deployedServer(): string {
    const pty = "server/node_modules/node-pty";
    const sqlite = "server/node_modules/better-sqlite3";
    for (const rel of [
      "server/package.json",
      "server/dist/cli/index.js",
      "server/assets/pg-hook",
      "server/src/index.ts",
      "server/tsconfig.json",
      "server/node_modules/.modules.yaml",
      "server/node_modules/.pnpm/lock.yaml",
      "server/node_modules/@promptgraph/shared/dist/index.js",
      "server/node_modules/@promptgraph/shared/src/index.ts",
      "server/node_modules/@promptgraph/shared/tsconfig.build.json",
      `${pty}/package.json`,
      `${pty}/lib/index.js`,
      `${pty}/build/Makefile`,
      `${pty}/build/config.gypi`,
      `${pty}/build/Release/pty.node`,
      `${pty}/build/Release/spawn-helper`,
      `${pty}/build/Release/obj.target/pty/src/unix/pty.o`,
      `${pty}/build/Release/.deps/Release/pty.node.d`,
      `${pty}/prebuilds/darwin-x64/pty.node`,
      `${pty}/deps/winpty/a.c`,
      `${pty}/third_party/conpty/x.dll`,
      `${pty}/src/unixTerminal.ts`,
      `${pty}/scripts/prebuild.js`,
      `${pty}/binding.gyp`,
      `${pty}/node_modules/node-addon-api/index.js`,
      `${sqlite}/package.json`,
      `${sqlite}/lib/index.js`,
      `${sqlite}/deps/sqlite3/sqlite3.c`,
      `${sqlite}/src/better_sqlite3.cpp`,
      `${sqlite}/build/Release/obj.target/x.o`,
      `${sqlite}/binding.gyp`,
      `${sqlite}/prebuilds/linux-x64.node`,
      `${sqlite}/prebuilds/linux-arm64.node`,
      `${sqlite}/prebuilds/linuxmusl-x64.node`,
      `${sqlite}/prebuilds/darwin-arm64.node`,
      "server/node_modules/hono/dist/index.js",
    ]) {
      write(rel);
    }
    fs.mkdirSync(path.join(tmp, "server/node_modules/.bin"), { recursive: true });
    fs.symlinkSync("../nanoid/bin/nanoid.cjs", path.join(tmp, "server/node_modules/.bin/nanoid"));
    fs.mkdirSync(path.join(tmp, `${pty}/node-addon-api@7.1.1/node_modules/node-addon-api`), { recursive: true });
    return path.join(tmp, "server");
  }

  it("applies the prune list, obj.target and .deps included, and keeps what runs", () => {
    const server = deployedServer();
    pruneTree(server);
    expect(files(server)).toEqual([
      "assets/pg-hook",
      "dist/cli/index.js",
      "node_modules/@promptgraph/shared/dist/index.js",
      "node_modules/better-sqlite3/lib/index.js",
      "node_modules/better-sqlite3/package.json",
      "node_modules/better-sqlite3/prebuilds/linux-x64.node",
      "node_modules/hono/dist/index.js",
      "node_modules/node-pty/build/Release/pty.node",
      "node_modules/node-pty/build/Release/spawn-helper",
      "node_modules/node-pty/lib/index.js",
      "node_modules/node-pty/node_modules/node-addon-api/index.js",
      "node_modules/node-pty/package.json",
      "package.json",
    ]);
    expect(fs.existsSync(path.join(server, "node_modules/node-pty/build/Release/obj.target"))).toBe(false);
    expect(fs.existsSync(path.join(server, "node_modules/node-pty/node-addon-api@7.1.1"))).toBe(false);
    expect(() => assertNoSymlinks(server)).not.toThrow();
  });

  it("is idempotent", () => {
    const server = deployedServer();
    pruneTree(server);
    const before = files(server);
    expect(pruneTree(server)).toEqual([]);
    expect(files(server)).toEqual(before);
  });

  it("lists the paths the design names", () => {
    for (const p of [
      "node_modules/.bin",
      "node_modules/node-pty/build/Release/obj.target",
      "node_modules/node-pty/build/Release/.deps",
      "!node_modules/node-pty/build/Release/pty.node",
      "!node_modules/node-pty/build/Release/spawn-helper",
      "node_modules/node-pty/prebuilds",
      "node_modules/node-pty/binding.gyp",
      "node_modules/better-sqlite3/deps",
      "node_modules/better-sqlite3/build",
      "!node_modules/better-sqlite3/prebuilds/linux-x64.node",
    ]) {
      expect(PRUNE_PATHS).toContain(p);
    }
  });
});

describe("guards", () => {
  it("assertPtyBuilt throws, naming onlyBuiltDependencies, when pty.node is missing", () => {
    const server = path.join(tmp, "server");
    write("server/node_modules/node-pty/package.json");
    expect(() => assertPtyBuilt(server)).toThrow(/onlyBuiltDependencies/);
    write("server/node_modules/node-pty/build/Release/pty.node");
    expect(() => assertPtyBuilt(server)).not.toThrow();
  });

  it("the symlink guard throws on a link anywhere, dangling or not", () => {
    write("stage/server/a.js");
    const stage = path.join(tmp, "stage");
    expect(() => assertNoSymlinks(stage)).not.toThrow();
    fs.symlinkSync("/nonexistent", path.join(stage, "server", "dangling"));
    expect(() => assertNoSymlinks(stage)).toThrow(/1 symlink.*server\/dangling/);
  });

  it("the size guard throws above the budget", () => {
    write("stage/a.bin", "x".repeat(1000));
    write("stage/sub/b.bin", "y".repeat(500));
    const stage = path.join(tmp, "stage");
    expect(treeSize(stage)).toBe(1500);
    expect(assertWithinBudget(stage, 1500)).toBe(1500);
    expect(() => assertWithinBudget(stage, 1499)).toThrow(/over the .* budget/);
    expect(SIZE_BUDGET_BYTES).toBe(170 * 1024 * 1024);
  });

  it("refuses to stage over /, the home directory or the repository", () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    expect(() => assertSafeStage("/")).toThrow(/refusing/);
    expect(() => assertSafeStage(os.homedir())).toThrow(/refusing/);
    expect(() => assertSafeStage(repo)).toThrow(/refusing/);
    expect(() => assertSafeStage(path.dirname(repo))).toThrow(/refusing/);
    expect(() => assertSafeStage(path.join(repo, "packages/desktop/runtime-stage"))).not.toThrow();
    expect(() => assertSafeStage(DEFAULT_STAGE)).not.toThrow();
  });

  it("refuses every path inside the repository but the default stage", () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    for (const rel of ["packages", "packages/desktop", "packages/server", "packages/desktop/src-tauri", "docs", ".git", "packages/desktop/stage-x"]) {
      expect(() => assertSafeStage(path.join(repo, rel)), rel).toThrow(/inside the repository only/);
    }
    // A path below the default stage is allowed (it does not exist).
    expect(() => assertSafeStage(path.join(DEFAULT_STAGE, "nested-test-stage"))).not.toThrow();
  });

  it("refuses ancestors of the home directory and resolves symlinks before comparing", () => {
    const repo = path.join(tmp, "repo");
    const home = path.join(tmp, "users", "me");
    const where = { repoRoot: repo, home, defaultStage: path.join(repo, "packages/desktop/runtime-stage") };
    fs.mkdirSync(path.join(repo, "packages/desktop/src-tauri"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    expect(() => assertSafeStage(path.join(tmp, "users"), where)).toThrow(/home directory/);
    expect(() => assertSafeStage(home, where)).toThrow(/home directory/);
    expect(() => assertSafeStage(path.join(home, "stage"), where)).not.toThrow();
    // A path outside the repository that leads into it through a symlinked parent.
    fs.symlinkSync(path.join(repo, "packages"), path.join(tmp, "pk"));
    expect(() => assertSafeStage(path.join(tmp, "pk", "desktop"), where)).toThrow(/inside the repository only/);
    expect(() => assertSafeStage(path.join(tmp, "pk", "desktop", "runtime-stage"), where)).not.toThrow();
  });

  it("refuses an existing path that is not a previous stage", () => {
    const where = { repoRoot: path.join(tmp, "repo"), home: path.join(tmp, "home"), defaultStage: path.join(tmp, "repo/rs") };
    const foreign = path.join(tmp, "foreign");
    write("foreign/notes.txt");
    expect(() => assertSafeStage(foreign, where)).toThrow(/does not look like a previous stage/);
    write("onlybin/bin/tool");
    expect(() => assertSafeStage(path.join(tmp, "onlybin"), where)).toThrow(/does not look like a previous stage/);
    write("mixed/server/package.json", "{}");
    write("mixed/src/index.ts");
    expect(() => assertSafeStage(path.join(tmp, "mixed"), where)).toThrow(/does not look like a previous stage/);
    write("file-stage");
    expect(() => assertSafeStage(path.join(tmp, "file-stage"), where)).toThrow(/not a directory/);
    fs.mkdirSync(path.join(tmp, "target"));
    fs.symlinkSync(path.join(tmp, "target"), path.join(tmp, "linked"));
    expect(() => assertSafeStage(path.join(tmp, "linked"), where)).toThrow(/symlink/);
  });

  it("accepts a missing or empty directory and a previous stage, complete or failed", () => {
    const where = { repoRoot: path.join(tmp, "repo"), home: path.join(tmp, "home"), defaultStage: path.join(tmp, "repo/rs") };
    expect(() => assertSafeStage(path.join(tmp, "missing"), where)).not.toThrow();
    fs.mkdirSync(path.join(tmp, "empty"));
    expect(() => assertSafeStage(path.join(tmp, "empty"), where)).not.toThrow();
    write("complete/bin/promptgraph", LAUNCHER, 0o755);
    write("complete/node/bin/node", "binary", 0o755);
    write("complete/server/package.json", "{}");
    write("complete/web/dist/index.html");
    write("complete/manifest.json", "{}");
    expect(() => assertSafeStage(path.join(tmp, "complete"), where)).not.toThrow();
    write("failed/server/package.json", "{}");
    expect(() => assertSafeStage(path.join(tmp, "failed"), where)).not.toThrow();
  });
});

describe("computeBuildId and the manifest", () => {
  function stage(): string {
    write("stage/bin/promptgraph", LAUNCHER, 0o755);
    write("stage/node/bin/node", "binary", 0o755);
    write("stage/server/dist/cli/index.js", "console.log(1)");
    write("stage/web/dist/index.html", "<!doctype html>");
    return path.join(tmp, "stage");
  }

  it("is stable across runs and ignores the manifest", async () => {
    const dir = stage();
    const id = computeBuildId(dir);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBuildId(dir)).toBe(id);
    await writeManifest(dir, { version: "0.1.0", nodeVersion: NODE_VERSION });
    expect(computeBuildId(dir)).toBe(id);
  });

  it("does not depend on directory order or timestamps", () => {
    const a = stage();
    const id = computeBuildId(a);
    const b = path.join(tmp, "copy");
    for (const rel of ["web/dist/index.html", "server/dist/cli/index.js", "node/bin/node", "bin/promptgraph"]) {
      const src = path.join(a, rel);
      const dest = path.join(b, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
      fs.utimesSync(dest, 1, 1);
    }
    expect(computeBuildId(b)).toBe(id);
  });

  it("changes with content", () => {
    const dir = stage();
    const id = computeBuildId(dir);
    fs.writeFileSync(path.join(dir, "server/dist/cli/index.js"), "console.log(2)");
    expect(computeBuildId(dir)).not.toBe(id);
  });

  it("changes with a file's mode", () => {
    const dir = stage();
    const id = computeBuildId(dir);
    fs.chmodSync(path.join(dir, "server/dist/cli/index.js"), 0o755);
    expect(computeBuildId(dir)).not.toBe(id);
  });

  it("changes with a file's path", () => {
    const dir = stage();
    const id = computeBuildId(dir);
    fs.renameSync(path.join(dir, "web/dist/index.html"), path.join(dir, "web/dist/index2.html"));
    expect(computeBuildId(dir)).not.toBe(id);
  });

  it("writes a manifest that validates against RuntimeManifestSchema", async () => {
    const dir = stage();
    const written = await writeManifest(dir, { version: "0.1.0", nodeVersion: NODE_VERSION });
    const onDisk = RuntimeManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
    expect(onDisk).toEqual(written);
    expect(onDisk).toEqual({ v: 1, version: "0.1.0", nodeVersion: "24.22.2", platform: "linux-x64", buildId: computeBuildId(dir) });
  });

  it("refuses a manifest that would not validate", async () => {
    await expect(writeManifest(stage(), { version: "", nodeVersion: NODE_VERSION })).rejects.toThrow();
  });
});

describe("LAUNCHER", () => {
  it("is exactly the launcher of DESIGN §20.6", () => {
    expect(LAUNCHER.split("\n")).toEqual([
      "#!/bin/sh",
      "# promptgraph runtime launcher (DESIGN §20.6)",
      'self=$(readlink -f -- "$0") || exit 127',
      'dir=$(dirname -- "$(dirname -- "$self")")',
      'exec "$dir/node/bin/node" "$dir/server/dist/cli/index.js" "$@"',
      "",
    ]);
  });

  it("exports no variable and never reads the working directory", () => {
    expect(LAUNCHER).not.toMatch(/\bexport\b/);
    expect(LAUNCHER).not.toMatch(/\bpwd\b|\$PWD/i);
  });

  it("runs the node and CLI of its own real directory, also through symlinks", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = path.join(tmp, "runtime", "0.1.0-abcdef12");
    write("runtime/0.1.0-abcdef12/bin/promptgraph", LAUNCHER, 0o755);
    // A fake node that prints its own path and its arguments.
    write("runtime/0.1.0-abcdef12/node/bin/node", '#!/bin/sh\necho "$0" "$@"\n', 0o755);
    fs.symlinkSync("0.1.0-abcdef12", path.join(tmp, "runtime", "current"));
    write("home/.local/bin/promptgraph", `#!/bin/sh\nexec ${JSON.stringify(path.join(tmp, "runtime/current/bin/promptgraph"))} "$@"\n`, 0o755);
    fs.symlinkSync(path.join(tmp, "runtime/current/bin/promptgraph"), path.join(tmp, "link"));
    for (const entry of [path.join(tmp, "runtime/current/bin/promptgraph"), path.join(tmp, "home/.local/bin/promptgraph"), path.join(tmp, "link")]) {
      const res = spawnSync(entry, ["mcp", "a b"], { encoding: "utf8", cwd: "/", env: { PATH: "/usr/bin:/bin" } });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(`${dir}/node/bin/node ${dir}/server/dist/cli/index.js mcp a b`);
    }
  });
});
