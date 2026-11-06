import { randomBytes } from "node:crypto";
import { LOGIN_CODE_TTL_MS } from "@promptgraph/shared";

const CODE_BYTES = 32;
/** Outstanding codes kept at most; minting beyond drops the oldest (only Bearer clients mint). */
const MAX_OUTSTANDING = 256;

export interface MintedLoginCode {
  code: string;
  expiresAt: number;
}

/** What a redeemed code carries to the session it creates. */
export interface LoginCodeGrant {
  /** Minted for the desktop window: the session is labelled "promptgraph desktop". */
  desktop: boolean;
}

export interface MintOptions {
  desktop?: boolean;
}

/**
 * One-time login codes (DESIGN §14): 32 random bytes (base64url), valid LOGIN_CODE_TTL_MS (30 s), single
 * use, held in memory only (a daemon restart drops them). `redeem` deletes the code whatever the
 * outcome, so a code is never accepted twice.
 */
export class LoginCodes {
  private readonly codes = new Map<string, { expiresAt: number; desktop: boolean }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  mint(now: number = this.now(), opts: MintOptions = {}): MintedLoginCode {
    this.prune(now);
    while (this.codes.size >= MAX_OUTSTANDING) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(CODE_BYTES).toString("base64url");
    const expiresAt = now + LOGIN_CODE_TTL_MS;
    this.codes.set(code, { expiresAt, desktop: opts.desktop === true });
    return { code, expiresAt };
  }

  /** The grant of a valid code (consumed), or null for an unknown, used or expired one. */
  redeem(code: string | null | undefined, now: number = this.now()): LoginCodeGrant | null {
    if (typeof code !== "string" || code === "") return null;
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return entry.expiresAt > now ? { desktop: entry.desktop } : null;
  }

  /** Drops every outstanding code (token rotation). */
  clear(): void {
    this.codes.clear();
  }

  /** Outstanding (not yet expired) codes; tests. */
  get size(): number {
    this.prune(this.now());
    return this.codes.size;
  }

  private prune(now: number): void {
    for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code);
  }
}
