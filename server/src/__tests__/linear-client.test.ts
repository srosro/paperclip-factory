import { describe, expect, it, vi } from "vitest";
import {
  createLinearClient,
  LinearApiError,
} from "../messaging/adapters/linear/client.js";

describe("linear client", () => {
  it("posts a GraphQL query with the Authorization header set", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { viewer: { id: "U_1", email: "x@y.z" } } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = createLinearClient({
      token: "lin_api_xxx",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const result = await client.request<{ viewer: { id: string; email: string } }>(
      "query { viewer { id email } }",
    );
    expect(result.viewer.id).toBe("U_1");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("lin_api_xxx");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("throws a typed LinearApiError on GraphQL errors", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: null,
            errors: [
              { message: "Invalid argument", extensions: { code: "INVALID_INPUT" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createLinearClient({
      token: "lin_api_x",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(client.request("query { x }")).rejects.toBeInstanceOf(LinearApiError);
  });

  it("retries on 429 with Retry-After respected", async () => {
    let attempt = 0;
    const fetchFn = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response("", {
          status: 429,
          headers: { "retry-after": "0.01" },
        });
      }
      return new Response(JSON.stringify({ data: { viewer: { id: "U_1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createLinearClient({
      token: "lin_api_x",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const result = await client.request<{ viewer: { id: string } }>(
      "query { viewer { id } }",
    );
    expect(result.viewer.id).toBe("U_1");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws unauthorized on HTTP 401", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "content-type": "text/plain" },
        }),
    );
    const client = createLinearClient({
      token: "lin_api_bad",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(client.request("query { viewer { id } }")).rejects.toMatchObject({
      code: "unauthorized",
      httpStatus: 401,
    });
  });
});
