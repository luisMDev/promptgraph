import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HELLO_PROOF_PREFIX } from "@promptgraph/shared";
import type { PgPaths } from "./paths.js";

const TOKEN_BYTES = 32;

/** `<PG_HOME>/token` (DESIGN §11.3, §14): the persistent per-user token, mode 0600. */
export function tokenPath(paths: PgPaths): string {
  return path.join(paths.home, "token");
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function tempFile(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * The persistent token, created on first use (32 random bytes, base64url). Creation is exclusive and
 * atomic: the value is written to a temp file (0600) that is then hard-linked to `token`, which fails
 * with EEXIST when another process created it first (that one wins and its value is read), so no reader
 * ever sees a partial file. The mode is re-asserted to 0600 on every call. An empty file is replaced.
 */
export function loadOrCreateToken(paths: PgPaths): string {
  const file = tokenPath(paths);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const tmp = tempFile(file);
  fs.writeFileSync(tmp, `${newToken()}\n`, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
  const token = fs.readFileSync(file, "utf8").trim();
  if (token) return token;
  const replacement = newToken();
  writeToken(paths, replacement);
  return replacement;
}

/** Replaces the token atomically (temp file 0600 + rename), e.g. on `promptgraph token rotate`. */
export function writeToken(paths: PgPaths, token: string): void {
  const file = tokenPath(paths);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const tmp = tempFile(file);
  try {
    fs.writeFileSync(tmp, `${token}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
}

/**
 * Proof that the daemon knows the token (DESIGN §4.1 item 3): base64url(HMAC-SHA256(token,
 * "hello:" + nonce)). Clients check it before they send the token anywhere.
 */
export function helloProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(HELLO_PROOF_PREFIX + nonce).digest("base64url");
}
