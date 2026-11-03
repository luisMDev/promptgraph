import { ApiErrorSchema } from "@promptgraph/shared";

/** A REST call answered with an ApiError (or a non-JSON error body). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Minimal REST client for a running promptgraph server (§12.1). Every request carries the per-start
 * token as a Bearer header; nothing is cached, so a restarted server is picked up on the next call.
 */
export class PromptgraphClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  protected async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`promptgraph server at ${this.baseUrl} is not reachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(data);
      if (parsed.success) throw new ApiRequestError(res.status, parsed.data.code, parsed.data.error, parsed.data.details);
      throw new ApiRequestError(res.status, undefined, `${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return data as T;
  }
}
