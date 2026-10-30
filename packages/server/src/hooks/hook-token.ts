import { createHmac } from "node:crypto";

/**
 * Per-node-run hook credential (§14): HMAC of the node run id under the session token. Claude PTYs
 * only get this value, which authorises POST /hooks/<nodeRunId>/* and nothing else, so neither the
 * agent nor its tools can drive the API with the session token.
 */
export function hookToken(sessionToken: string, nodeRunId: string): string {
  return createHmac("sha256", sessionToken).update(`hook:${nodeRunId}`).digest("base64url");
}

/**
 * Value of the browser's session cookie: an HMAC of the session token, not the token itself. Cookies are
 * not port-scoped, so every other server on 127.0.0.1 the browser talks to receives it; this value is
 * accepted only as the cookie (never as a Bearer token) and cannot derive hook tokens.
 */
export function sessionCookieValue(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("cookie").digest("base64url");
}
