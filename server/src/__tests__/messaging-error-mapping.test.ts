import { describe, it, expect } from "vitest";
import {
  translateMessagingError,
  HttpError,
} from "../errors.js";
import {
  MessagingBackendUnavailable,
  MessagingIdentityNotActive,
  MessagingNotConfigured,
  MessagingThreadLocked,
} from "../messaging/types.js";

describe("translateMessagingError", () => {
  it("maps MessagingNotConfigured to 412 with messaging_not_configured", () => {
    const translated = translateMessagingError(new MessagingNotConfigured("co-1"));
    expect(translated).toBeInstanceOf(HttpError);
    expect((translated as HttpError).status).toBe(412);
    expect((translated as HttpError).details).toMatchObject({
      code: "messaging_not_configured",
      companyId: "co-1",
    });
  });

  it("maps MessagingIdentityNotActive to 412 with agent_identity_not_linked", () => {
    const translated = translateMessagingError(new MessagingIdentityNotActive("id-1"));
    expect((translated as HttpError).status).toBe(412);
    expect((translated as HttpError).details).toMatchObject({
      code: "agent_identity_not_linked",
      identityId: "id-1",
    });
  });

  it("maps MessagingThreadLocked to 409 with messaging_thread_locked", () => {
    const translated = translateMessagingError(new MessagingThreadLocked("thread-1"));
    expect((translated as HttpError).status).toBe(409);
    expect((translated as HttpError).details).toMatchObject({
      code: "messaging_thread_locked",
      threadId: "thread-1",
    });
  });

  it("maps MessagingBackendUnavailable(rate_limited) to 429 with retry-after", () => {
    const translated = translateMessagingError(
      new MessagingBackendUnavailable("rate limited", "rate_limited", 5),
    );
    expect((translated as HttpError).status).toBe(429);
    expect((translated as HttpError).details).toMatchObject({
      code: "messaging_rate_limited",
      retryAfterSec: 5,
    });
  });

  it("maps other MessagingBackendUnavailable variants to 503", () => {
    const translated = translateMessagingError(
      new MessagingBackendUnavailable("exhausted retries", "exhausted"),
    );
    expect((translated as HttpError).status).toBe(503);
    expect((translated as HttpError).details).toMatchObject({
      code: "messaging_backend_unavailable",
      reason: "exhausted",
    });
  });

  it("passes through non-messaging errors unchanged", () => {
    const err = new Error("unrelated");
    expect(translateMessagingError(err)).toBe(err);
  });
});
