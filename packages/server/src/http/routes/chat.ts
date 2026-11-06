import {
  CreateChatSessionRequestSchema,
  type CreateChatSessionResponse,
  type GetChatSessionResponse,
  type ListChatSessionsResponse,
  type OkResponse,
} from "@promptgraph/shared";
import { HttpError, readBody } from "../errors.js";
import { REPO_PREFIX, repoOf, type App } from "../repo-scope.js";

const P = REPO_PREFIX;

/**
 * Under /api/repos/:repoId (§21): GET/POST …/chat/sessions · GET/DELETE …/chat/sessions/:id, served by
 * that repository's ChatManager. Messages go over the WebSocket.
 */
export function registerChatRoutes(app: App): void {
  app.get(`${P}/chat/sessions`, (c) => c.json<ListChatSessionsResponse>({ sessions: repoOf(c).chat.list() }));

  app.post(`${P}/chat/sessions`, async (c) => {
    const body = await readBody(c, CreateChatSessionRequestSchema);
    return c.json<CreateChatSessionResponse>({ session: repoOf(c).chat.create(body) });
  });

  app.get(`${P}/chat/sessions/:id`, (c) => {
    const detail = repoOf(c).chat.get(c.req.param("id"));
    if (!detail) throw notFound(c.req.param("id"));
    return c.json<GetChatSessionResponse>(detail);
  });

  app.delete(`${P}/chat/sessions/:id`, (c) => {
    if (!repoOf(c).chat.delete(c.req.param("id"))) throw notFound(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });
}

function notFound(id: string): HttpError {
  return new HttpError(404, "not_found", `Chat session ${id} not found`);
}
