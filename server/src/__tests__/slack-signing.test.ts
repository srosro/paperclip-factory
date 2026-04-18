import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifySlackSignature } from "../messaging/adapters/slack/signing.js";

function signFor(signingSecret: string, timestamp: string, body: string): string {
  return "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
}

describe("verifySlackSignature", () => {
  const signingSecret = "abcdef_signing_secret";
  const nowSec = 1700000000;
  const timestamp = String(nowSec);
  const body = '{"type":"event_callback","event":{"type":"message"}}';

  it("accepts a valid signature within the skew window", () => {
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: timestamp,
      signatureHeader: signFor(signingSecret, timestamp, body),
      rawBody: body,
      nowSec,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: timestamp,
      signatureHeader: signFor(signingSecret, timestamp, body),
      rawBody: body + "TAMPERED",
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature signed with a different secret", () => {
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: timestamp,
      signatureHeader: signFor("other_secret", timestamp, body),
      rawBody: body,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("rejects a stale timestamp beyond the skew window", () => {
    const staleTs = String(nowSec - 60 * 10);
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: staleTs,
      signatureHeader: signFor(signingSecret, staleTs, body),
      rawBody: body,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("rejects a future timestamp beyond the skew window", () => {
    const futureTs = String(nowSec + 60 * 10);
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: futureTs,
      signatureHeader: signFor(signingSecret, futureTs, body),
      rawBody: body,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const ok = verifySlackSignature({
      signingSecret,
      timestampHeader: "not-a-number",
      signatureHeader: signFor(signingSecret, "not-a-number", body),
      rawBody: body,
      nowSec,
    });
    expect(ok).toBe(false);
  });
});
