import { randomUUID } from "node:crypto";
import { customAlphabet } from "nanoid";

const alnum = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const short = customAlphabet("0123456789abcdef", 4);

/** Ids for runs, node runs and ptys: 12 lowercase alphanumerics. */
export function newId(): string {
  return alnum();
}

/** 4 hex chars used in branch names (§9.1). */
export function newShortId(): string {
  return short();
}

/** Claude session ids must be UUIDs (--session-id). */
export function newSessionId(): string {
  return randomUUID();
}
