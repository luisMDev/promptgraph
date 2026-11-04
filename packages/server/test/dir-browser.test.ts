import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHome, listDirs } from "../src/daemon/dir-browser.js";
import { HttpError } from "../src/http/errors.js";
import { tempDir } from "./helpers.js";

let root: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir());
  fs.mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "Beta"));
  fs.mkdirSync(path.join(root, "worktree"));
  fs.writeFileSync(path.join(root, "worktree", ".git"), "gitdir: /elsewhere\n");
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "file.txt"), "not a dir");
  fs.symlinkSync(path.join(root, "Beta"), path.join(root, "link-to-beta"));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "broken-link"));
});
afterEach(() => cleanup());

const env = () => ({ HOME: root });

describe("listDirs (DESIGN §13.3 folder picker)", () => {
  it("lists subdirectories sorted by name, flags git repositories, skips files, dot-dirs and broken links", async () => {
    const r = await listDirs(root, { env: env() });
    expect(r.path).toBe(path.resolve(root));
    expect(r.parent).toBe(path.dirname(path.resolve(root)));
    expect(r.home).toBe(root);
    expect(r.isGitRepo).toBe(false);
    expect(r.entries).toEqual([
      { name: "alpha", path: path.join(root, "alpha"), isGitRepo: true },
      { name: "Beta", path: path.join(root, "Beta"), isGitRepo: false },
      { name: "link-to-beta", path: path.join(root, "link-to-beta"), isGitRepo: false },
      { name: "worktree", path: path.join(root, "worktree"), isGitRepo: true },
    ]);
  });

  it("includes dot-directories with hidden, defaults to home and expands ~", async () => {
    expect((await listDirs(root, { env: env(), hidden: true })).entries.map((e) => e.name)).toContain(".hidden");
    expect((await listDirs(undefined, { env: env() })).path).toBe(path.resolve(root));
    const alpha = await listDirs("~/alpha", { env: env() });
    expect(alpha.path).toBe(path.join(root, "alpha"));
    expect(alpha.isGitRepo).toBe(true);
    expect((await listDirs("/", { env: env() })).parent).toBeNull();
  });

  it("refuses relative paths (422) and non-directories (404)", async () => {
    await expect(listDirs("relative/dir", { env: env() })).rejects.toMatchObject({ status: 422, code: "path_not_absolute" });
    await expect(listDirs(path.join(root, "file.txt"), { env: env() })).rejects.toMatchObject({ status: 404, code: "not_a_directory" });
    await expect(listDirs(path.join(root, "nope"), { env: env() })).rejects.toBeInstanceOf(HttpError);
  });

  it("expandHome only touches ~ and ~/", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/x", "/h")).toBe("/h/x");
    expect(expandHome("~x", "/h")).toBe("~x");
    expect(expandHome("/abs", "/h")).toBe("/abs");
  });
});
