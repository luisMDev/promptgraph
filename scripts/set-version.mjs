#!/usr/bin/env node
// Keeps every versioned file of the workspace on one version (DESIGN §20.4): the app version the updater
// compares, the runtime's CLI version and the daemon version of the handover are the same number.
//
//   node scripts/set-version.mjs X.Y.Z[-pre]
//
// Idempotent; refuses anything but X.Y.Z[-pre] (exit 2). Each file is replaced atomically, and a failed
// write restores the files already changed (a kill between two renames can still leave a mix; the sync
// test reports it). The exports are for the sync test (packages/desktop/test/versions.test.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** X.Y.Z with an optional pre-release (no build metadata: Cargo and the updater compare these). */
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * @typedef {object} VersionFile
 * @property {string} file   path relative to the repository root
 * @property {RegExp} pattern  its first match holds the version in group 2, between groups 1 and 3
 * @property {(text: string) => string | undefined} [check]  the version read another way, to confirm the edit
 */

/** @param {string} text @returns {string | undefined} */
const jsonVersion = (text) => JSON.parse(text).version;

/** The top-level "version" of a JSON file whose first "version" key is the top-level one (checked by jsonVersion). */
const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(")/m;

/** @type {readonly VersionFile[]} */
export const VERSION_FILES = [
  { file: "packages/shared/package.json", pattern: JSON_VERSION, check: jsonVersion },
  { file: "packages/server/package.json", pattern: JSON_VERSION, check: jsonVersion },
  { file: "packages/web/package.json", pattern: JSON_VERSION, check: jsonVersion },
  { file: "packages/desktop/package.json", pattern: JSON_VERSION, check: jsonVersion },
  { file: "packages/server/src/config/version.ts", pattern: /^(const PACKAGE_VERSION = ")([^"]*)(";)$/m },
  // The [package] table's version: the first `version =` line after `[package]`, before any other table.
  { file: "packages/desktop/src-tauri/Cargo.toml", pattern: /(^\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]*)(")/m },
  { file: "packages/desktop/src-tauri/Cargo.lock", pattern: /(^\[\[package\]\]\nname = "promptgraph-desktop"\nversion = ")([^"]*)(")/m },
  { file: "packages/desktop/src-tauri/tauri.conf.json", pattern: JSON_VERSION, check: jsonVersion },
  { file: "plugins/promptgraph/.claude-plugin/plugin.json", pattern: JSON_VERSION, check: jsonVersion },
];

/**
 * @param {string} root
 * @param {VersionFile} entry
 * @returns {{text: string, match: RegExpExecArray}}
 */
function locate(root, entry) {
  const text = fs.readFileSync(path.join(root, entry.file), "utf8");
  const match = entry.pattern.exec(text);
  if (!match) throw new Error(`${entry.file}: no version found`);
  if (entry.check && entry.check(text) !== match[2]) throw new Error(`${entry.file}: the first "version" key is not the top-level one`);
  return { text, match };
}

/**
 * The version each file carries.
 * @param {string} [root]
 * @returns {Record<string, string>}
 */
export function readVersions(root = ROOT) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const entry of VERSION_FILES) out[entry.file] = /** @type {string} */ (locate(root, entry).match[2]);
  return out;
}

/**
 * Writes `version` into every file of VERSION_FILES (files that already carry it are not rewritten).
 * @param {string} version
 * @param {string} [root]
 * @returns {string[]} the files that changed
 */
export function setVersion(version, root = ROOT) {
  if (!VERSION_PATTERN.test(version)) throw new RangeError(`invalid version ${JSON.stringify(version)}: expected X.Y.Z or X.Y.Z-pre`);
  // Read and check every file first, so a file that cannot be edited leaves all of them untouched.
  const edits = VERSION_FILES.map((entry) => {
    const { text, match } = locate(root, entry);
    const start = match.index + /** @type {string} */ (match[1]).length;
    const next = text.slice(0, start) + version + text.slice(start + /** @type {string} */ (match[2]).length);
    if (entry.check && entry.check(next) !== version) throw new Error(`${entry.file}: the edit did not change the top-level version`);
    return { entry, text, next };
  });
  const pending = edits.filter(({ next, text }) => next !== text);
  /** @type {typeof pending} */
  const written = [];
  try {
    for (const edit of pending) {
      writeAtomic(path.join(root, edit.entry.file), edit.next);
      written.push(edit);
    }
  } catch (err) {
    // Put back the files already rewritten, from the text read above, so a failed run leaves no mix of versions.
    const notRestored = [];
    for (const { entry, text } of written.reverse()) {
      try {
        writeAtomic(path.join(root, entry.file), text);
      } catch {
        notRestored.push(entry.file);
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(notRestored.length ? `${detail}; could not restore ${notRestored.join(", ")}` : `${detail} (no file changed)`);
  }
  return pending.map(({ entry }) => entry.file);
}

/**
 * Replaces `file` with `text` through a sibling temporary file and a rename, so the file is never seen
 * truncated or half-written; the file's mode is kept.
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.set-version-${process.pid}.tmp`);
  try {
    const { mode } = fs.statSync(file);
    fs.writeFileSync(tmp, text, { mode: mode & 0o7777, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !VERSION_PATTERN.test(args[0] ?? "")) {
    process.stderr.write(`usage: node scripts/set-version.mjs X.Y.Z[-pre]${args.length === 1 ? ` (invalid version ${JSON.stringify(args[0])})` : ""}\n`);
    process.exit(2);
  }
  try {
    const version = /** @type {string} */ (args[0]);
    const changed = setVersion(version);
    process.stdout.write(changed.length ? `set ${version} in:\n${changed.map((f) => `  ${f}\n`).join("")}` : `every file already carries ${version}\n`);
  } catch (err) {
    process.stderr.write(`set-version: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
