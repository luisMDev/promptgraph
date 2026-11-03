import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/config/paths.js";
import { helloProof, loadOrCreateToken, tokenPath, writeToken } from "../src/config/token.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function paths() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return getPaths({ PG_HOME: `${t.dir}/pg-home` });
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("persistent token (DESIGN §14)", () => {
  it("creates a 32-byte base64url token with mode 0600 and returns the same one afterwards", () => {
    const p = paths();
    const token = loadOrCreateToken(p);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mode(tokenPath(p))).toBe(0o600);
    expect(mode(p.home)).toBe(0o700);
    expect(loadOrCreateToken(p)).toBe(token);
    // No temp files are left behind.
    expect(fs.readdirSync(p.home)).toEqual(["token"]);
  });

  it("re-asserts mode 0600 on every call", () => {
    const p = paths();
    const token = loadOrCreateToken(p);
    fs.chmodSync(tokenPath(p), 0o644);
    expect(loadOrCreateToken(p)).toBe(token);
    expect(mode(tokenPath(p))).toBe(0o600);
  });

  it("replaces an empty token file", () => {
    const p = paths();
    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(tokenPath(p), "");
    const token = loadOrCreateToken(p);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadOrCreateToken(p)).toBe(token);
  });

  it("writeToken replaces the file atomically with mode 0600", () => {
    const p = paths();
    loadOrCreateToken(p);
    const inode = fs.statSync(tokenPath(p)).ino;
    writeToken(p, "rotated-token");
    expect(loadOrCreateToken(p)).toBe("rotated-token");
    expect(mode(tokenPath(p))).toBe(0o600);
    // A rename, not an in-place rewrite: a concurrent reader sees the old or the new file, never a partial one.
    expect(fs.statSync(tokenPath(p)).ino).not.toBe(inode);
    expect(fs.readdirSync(p.home)).toEqual(["token"]);
  });

  it("helloProof is a deterministic HMAC that depends on the token and the nonce", () => {
    const proof = helloProof("tok", "nonce-1");
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(helloProof("tok", "nonce-1")).toBe(proof);
    expect(helloProof("tok", "nonce-2")).not.toBe(proof);
    expect(helloProof("other", "nonce-1")).not.toBe(proof);
  });
});
