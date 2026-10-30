import { createHmac } from "node:crypto";

/**
 * Per-node-run hook credential (§14): HMAC of the node run id under the session token. Claude PTYs
 * only get this value, which authorises POST /hooks/<nodeRunId>/* and nothing else, so neither the
 * agent nor its tools can drive the API with the session token.
 */
export function hookToken(sessionToken: string, nodeRunId: string): string {
  return createHmac("sha256", sessionToken).update(`hook:${nodeRunId}`).digest("base64url");
}
