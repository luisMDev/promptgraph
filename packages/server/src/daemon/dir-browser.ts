import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DirEntry, ListDirsResponse } from "@promptgraph/shared";
import { HttpError } from "../http/errors.js";

/** The daemon user's home: `HOME` of the daemon's environment, else the OS account's. */
export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

/** `~` and `~/…` expanded against `home`; anything else is returned unchanged. */
export function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

async function hasGit(dir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Subdirectories of one directory for Home's folder picker (DESIGN §13.3). Only names and a `.git` probe
 * per entry: no file contents are read. Symlinks are followed to decide whether an entry is a directory;
 * broken or unreadable entries are skipped.
 */
export async function listDirs(input: string | undefined, opts: { env: NodeJS.ProcessEnv; hidden?: boolean }): Promise<ListDirsResponse> {
  const home = homeDir(opts.env);
  const raw = input?.trim() ? expandHome(input.trim(), home) : home;
  if (!path.isAbsolute(raw)) throw new HttpError(422, "path_not_absolute", `Path must be absolute (or start with ~/): ${input}`);
  const dir = path.resolve(raw);

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new HttpError(403, "permission_denied", `Permission denied: ${dir}`);
    throw new HttpError(404, "not_a_directory", `Not a directory: ${dir}`);
  }

  const candidates = dirents.filter((d) => (opts.hidden || !d.name.startsWith(".")) && (d.isDirectory() || d.isSymbolicLink()));
  const entries = (
    await Promise.all(
      candidates.map(async (d): Promise<DirEntry | null> => {
        const p = path.join(dir, d.name);
        if (d.isSymbolicLink() && !(await isDirectory(p))) return null;
        return { name: d.name, path: p, isGitRepo: await hasGit(p) };
      }),
    )
  )
    .filter((e): e is DirEntry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home, isGitRepo: await hasGit(dir), entries };
}
