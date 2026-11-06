import { VOICE_API_PATH, type VoiceStatus } from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import type { App } from "../repo-scope.js";

/**
 * GET /api/voice → VoiceStatus (§22.3), daemon-wide. The probe is cached briefly; `?refresh=1` ("Check again") re-probes
 * right away, so a whisper.cpp installed a second ago is picked up.
 *
 * A re-probe spawns `whisper-cli --help`, so `refresh` is only honoured for requests the browser marks as
 * same-origin (or that carry no Sec-Fetch-Site, e.g. API clients with the Bearer header): the session cookie is
 * also sent with subresource GETs from other localhost ports (§14), and those get the cached status instead.
 * VoiceService additionally coalesces concurrent and rapid refreshes into one probe.
 */
export function registerVoiceRoutes(app: App, daemon: DaemonContext): void {
  app.get(VOICE_API_PATH, async (c) => {
    const site = c.req.header("sec-fetch-site");
    const refresh = c.req.query("refresh") === "1" && (site === undefined || site === "same-origin" || site === "none");
    return c.json<VoiceStatus>(await daemon.voice.status({ refresh }));
  });
}
