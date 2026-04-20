import type { LinearGraphQLResponse } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly graphqlErrors?: Array<{
      message: string;
      extensions?: Record<string, unknown>;
    }>,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

export interface LinearClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface CreateLinearClientOptions {
  token: string;
  fetch?: typeof fetch;
  maxRetries?: number;
}

export function createLinearClient(opts: CreateLinearClientOptions): LinearClient {
  const fetchFn = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  return {
    async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const res = await fetchFn(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: {
            Authorization: opts.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
        });

        if (res.status === 429) {
          const retryAfterHeader = res.headers.get("retry-after") ?? "1";
          const waitSec = Number(retryAfterHeader);
          await new Promise((r) =>
            setTimeout(r, Number.isFinite(waitSec) ? waitSec * 1000 : 1000),
          );
          lastError = new LinearApiError(
            "Rate limited",
            "rate_limited",
            undefined,
            429,
          );
          continue;
        }

        if (res.status >= 500) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
          lastError = new LinearApiError(
            `Linear 5xx: ${res.status}`,
            "server_error",
            undefined,
            res.status,
          );
          continue;
        }

        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          throw new LinearApiError(
            `Linear HTTP ${res.status}: ${bodyText}`,
            res.status === 401 ? "unauthorized" : "http_error",
            undefined,
            res.status,
          );
        }

        const json = (await res.json()) as LinearGraphQLResponse<T>;
        if (json.errors && json.errors.length > 0) {
          const code =
            (json.errors[0]!.extensions?.code as string | undefined) ??
            "graphql_error";
          throw new LinearApiError(
            json.errors[0]!.message,
            code,
            json.errors,
            res.status,
          );
        }
        if (!json.data) {
          throw new LinearApiError("Linear returned empty data", "empty_response");
        }
        return json.data;
      }
      throw lastError instanceof Error
        ? lastError
        : new LinearApiError("Retries exhausted", "retries_exhausted");
    },
  };
}
