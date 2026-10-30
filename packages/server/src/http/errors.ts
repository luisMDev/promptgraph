import type { ApiError } from "@promptgraph/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { EngineError } from "../engine/engine.js";
import { GraphLoadError, GraphNotFoundError } from "../graphs/graph-store.js";

/** An error with an explicit HTTP status, thrown by route handlers. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const ENGINE_STATUS: Record<EngineError["code"], ContentfulStatusCode> = {
  not_found: 404,
  validation_failed: 422,
  run_active: 409,
  invalid_state: 409,
  load_error: 422,
};

/** Maps any thrown value to an ApiError response (CONTRACTS § HTTP). */
export function toApiError(err: unknown): { status: ContentfulStatusCode; body: ApiError } {
  if (err instanceof HttpError) return { status: err.status, body: apiError(err.message, err.code, err.details) };
  if (err instanceof z.ZodError) {
    return { status: 400, body: apiError(z.prettifyError(err), "bad_request", err.issues) };
  }
  if (err instanceof EngineError) return { status: ENGINE_STATUS[err.code], body: apiError(err.message, err.code, err.details) };
  if (err instanceof GraphNotFoundError) return { status: 404, body: apiError(err.message, "not_found") };
  if (err instanceof GraphLoadError) return { status: 422, body: apiError(err.message, "invalid_graph", err.details) };
  return { status: 500, body: apiError(err instanceof Error ? err.message : String(err), "internal") };
}

function apiError(error: string, code: string, details?: unknown): ApiError {
  return details === undefined ? { error, code } : { error, code, details };
}

/** JSON body validated with `schema`; an empty body counts as `{}`. Bad JSON → 400, zod errors → 400 via onError. */
export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  return schema.parse(await readJson(c));
}

/** Raw JSON body (empty → `{}`). */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_request", "Request body is not valid JSON");
  }
}
