import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../messaging/adapters/slack/client.js";
import { MessagingBackendUnavailable } from "../messaging/types.js";

function ratelimitError(retryAfter?: number): Error {
  const err = new Error("ratelimited") as Error & {
    data?: { error?: string; retry_after?: number };
  };
  err.data = { error: "ratelimited" };
  if (retryAfter !== undefined) err.data.retry_after = retryAfter;
  return err;
}

function server5xx(status: number): Error {
  const err = new Error("server error") as Error & { status?: number };
  err.status = status;
  return err;
}

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(ratelimitError(0))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx with backoff then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(server5xx(502))
      .mockRejectedValueOnce(server5xx(503))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { initialBackoffMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws MessagingBackendUnavailable after exhausting rate-limit retries", async () => {
    const fn = vi.fn().mockRejectedValue(ratelimitError(0));
    await expect(withRetry(fn, { retries: 2 })).rejects.toBeInstanceOf(
      MessagingBackendUnavailable,
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws MessagingBackendUnavailable after exhausting 5xx retries", async () => {
    const fn = vi.fn().mockRejectedValue(server5xx(500));
    await expect(
      withRetry(fn, { retries: 2, initialBackoffMs: 1 }),
    ).rejects.toBeInstanceOf(MessagingBackendUnavailable);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("bad_request"));
    await expect(withRetry(fn, { retries: 3 })).rejects.toThrow("bad_request");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
