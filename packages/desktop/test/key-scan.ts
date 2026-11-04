import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Updater private-key material (DESIGN §20.11): the minisign/rsign header in plain text, and the base64 of
 * its whole 3-byte groups (a Tauri key file is the base64 of the whole minisign file, so the plain header
 * never appears in it). Assembled at run time so this file never matches itself.
 */
const KEY_NEEDLES = ["rsign", "minisign"].flatMap((kind) => {
  const header = "untrusted comment: " + kind + " encrypted secret key";
  const aligned = header.slice(0, header.length - (header.length % 3));
  return [header, Buffer.from(aligned).toString("base64")];
});

/** The files of `files` that carry key material; unreadable ones (deleted in the working tree) are skipped. */
export function filesWithKeyMaterial(files: string[]): string[] {
  return files.filter((file) => {
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch {
      return false;
    }
    return KEY_NEEDLES.some((needle) => data.includes(needle));
  });
}

/** Every tracked file and every untracked file git does not ignore, under the git work tree `root`. */
export function repoFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return listed
    .split("\0")
    .filter(Boolean)
    .map((f) => path.join(root, f));
}

/** The files of the git work tree `root` (repoFiles) that carry key material, as absolute paths. */
export function repoFilesWithKeyMaterial(root: string): string[] {
  return filesWithKeyMaterial(repoFiles(root));
}
