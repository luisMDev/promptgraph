import {
  CreateChatSessionRequestSchema,
  type CreateChatSessionResponse,
  type GetChatSessionResponse,
  type ListChatSessionsResponse,
  type OkResponse,
} from "@promptgraph/shared";
import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";
import { HttpError, readBody } from "../errors.js";

/** GET/POST /api/chat/sessions · GET/DELETE /api/chat/sessions/:id (§20). Messages go over the WebSocket. */
export function registerChatRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/chat/sessions", (c) => c.json<ListChatSessionsResponse>({ sessions: ctx.chat.list() }));

  app.post("/api/chat/sessions", async (c) => {
    const body = await readBody(c, CreateChatSessionRequestSchema);
    return c.json<CreateChatSessionResponse>({ session: ctx.chat.create(body) });
  });

  app.get("/api/chat/sessions/:id", (c) => {
    const detail = ctx.chat.get(c.req.param("id"));
    if (!detail) throw notFound(c.req.param("id"));
    return c.json<GetChatSessionResponse>(detail);
  });

  app.delete("/api/chat/sessions/:id", (c) => {
    if (!ctx.chat.delete(c.req.param("id"))) throw notFound(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });
}

function notFound(id: string): HttpError {
  return new HttpError(404, "not_found", `Chat session ${id} not found`);
}
