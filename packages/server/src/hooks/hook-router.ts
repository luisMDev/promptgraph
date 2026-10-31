import { HOOK_PAYLOAD_SCHEMAS, HookEventSchema, type HookEvent, type HookPayloadMap } from "@promptgraph/shared";

/** A validated hook delivery for one node run. */
export type HookMessage = { [K in HookEvent]: { event: K; payload: HookPayloadMap[K] } }[HookEvent];
export type HookHandler = (message: HookMessage) => void;

export type HookDispatchResult = "ok" | "unknown_node_run" | "invalid_event" | "invalid_payload";

/**
 * Routes POST /hooks/:nodeRunId/:event to the ClaudeRunner execution that registered the node run.
 * Payloads are validated with HOOK_PAYLOAD_SCHEMAS. Unknown node runs are ignored (late hooks after exit).
 */
export class HookRouter {
  private readonly handlers = new Map<string, HookHandler>();

  /** Returns an unregister function. A second registration for the same id replaces the first. */
  register(nodeRunId: string, handler: HookHandler): () => void {
    this.handlers.set(nodeRunId, handler);
    return () => {
      if (this.handlers.get(nodeRunId) === handler) this.handlers.delete(nodeRunId);
    };
  }

  dispatch(nodeRunId: string, event: string, body: unknown): HookDispatchResult {
    const parsedEvent = HookEventSchema.safeParse(event);
    if (!parsedEvent.success) return "invalid_event";
    const handler = this.handlers.get(nodeRunId);
    if (!handler) return "unknown_node_run";
    const parsed = HOOK_PAYLOAD_SCHEMAS[parsedEvent.data].safeParse(body);
    if (!parsed.success) return "invalid_payload";
    try {
      handler({ event: parsedEvent.data, payload: parsed.data } as HookMessage);
    } catch {
      // A failing handler must never turn into an error for Claude's hook.
    }
    return "ok";
  }
}
