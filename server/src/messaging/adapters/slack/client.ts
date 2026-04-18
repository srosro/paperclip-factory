import { WebClient, type WebAPICallResult } from "@slack/web-api";
import { MessagingBackendUnavailable } from "../../types.js";

export interface RetryOptions {
  retries?: number;
  initialBackoffMs?: number;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 500;

function extractRetryAfterSec(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const any = err as {
    data?: { retry_after?: number };
    headers?: Record<string, string | string[]>;
  };
  if (typeof any.data?.retry_after === "number") return any.data.retry_after;
  const hdr = any.headers?.["retry-after"];
  if (typeof hdr === "string") {
    const n = Number(hdr);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isRateLimited(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const any = err as { data?: { error?: string }; code?: string };
  return (
    any.data?.error === "ratelimited" ||
    any.code === "slack_webapi_platform_error_ratelimited"
  );
}

function isRetryable5xx(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const any = err as { status?: number; statusCode?: number };
  const s = any.status ?? any.statusCode;
  return typeof s === "number" && s >= 500 && s < 600;
}

/**
 * Execute an async Slack call with in-memory retry/backoff. Matches the
 * fail-fast posture from the spec: no persistent outbox, short retries only,
 * then surface as MessagingBackendUnavailable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const initialBackoff = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (isRateLimited(err)) {
        const retryAfter = extractRetryAfterSec(err) ?? 2;
        if (attempt === retries - 1) {
          throw new MessagingBackendUnavailable(
            "slack rate limited",
            "rate_limited",
            retryAfter,
          );
        }
        const waitMs = retryAfter * 1000;
        opts.onRetry?.(attempt, waitMs, err);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (isRetryable5xx(err)) {
        if (attempt === retries - 1) {
          throw new MessagingBackendUnavailable("slack 5xx", "backend_5xx");
        }
        const waitMs = initialBackoff * Math.pow(2, attempt);
        opts.onRetry?.(attempt, waitMs, err);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      throw err;
    }
  }
  throw lastErr ??
    new MessagingBackendUnavailable("retry loop exhausted", "exhausted");
}

export function slackClient(token: string): WebClient {
  return new WebClient(token);
}

export type { WebAPICallResult };
