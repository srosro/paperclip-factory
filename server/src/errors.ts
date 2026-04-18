export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function preconditionFailed(message: string, details?: unknown) {
  return new HttpError(412, message, details);
}

export function rateLimited(message: string, details?: unknown) {
  return new HttpError(429, message, details);
}

export function serviceUnavailable(message: string, details?: unknown) {
  return new HttpError(503, message, details);
}

import {
  MessagingBackendUnavailable,
  MessagingIdentityNotActive,
  MessagingNotConfigured,
  MessagingThreadLocked,
} from "./messaging/types.js";

/**
 * Translate typed messaging errors into the public HTTP error envelope.
 * Returns the original value unchanged when it's not a messaging error.
 */
export function translateMessagingError(err: unknown): unknown {
  if (err instanceof MessagingNotConfigured) {
    return preconditionFailed("Messaging is not configured for this company", {
      code: "messaging_not_configured",
      companyId: err.companyId,
    });
  }
  if (err instanceof MessagingIdentityNotActive) {
    return preconditionFailed(
      "The acting agent does not have an active messaging identity",
      { code: "agent_identity_not_linked", identityId: err.identityId },
    );
  }
  if (err instanceof MessagingThreadLocked) {
    return conflict("The issue thread is locked for further comments", {
      code: "messaging_thread_locked",
      threadId: err.threadId,
    });
  }
  if (err instanceof MessagingBackendUnavailable) {
    if (err.code === "rate_limited") {
      return rateLimited("Messaging backend rate limit exceeded", {
        code: "messaging_rate_limited",
        retryAfterSec: err.retryAfterSec,
      });
    }
    return serviceUnavailable("Messaging backend is unavailable", {
      code: "messaging_backend_unavailable",
      reason: err.code,
    });
  }
  return err;
}
