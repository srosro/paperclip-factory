import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyLinearSignature } from "../messaging/adapters/linear/webhook.js";

describe("linear webhook signature", () => {
  it("verifies a correctly-signed body", () => {
    const secret = "shhh";
    const body = JSON.stringify({ type: "Comment", action: "create", data: {} });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyLinearSignature({ signature, rawBody: body, secret })).toBe(true);
  });

  it("rejects a mismatched signature", () => {
    const secret = "shhh";
    const body = JSON.stringify({ type: "Comment" });
    const badSig = createHmac("sha256", "wrong").update(body).digest("hex");
    expect(verifyLinearSignature({ signature: badSig, rawBody: body, secret })).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(
      verifyLinearSignature({ signature: "", rawBody: "{}", secret: "s" }),
    ).toBe(false);
  });

  it("rejects malformed hex signature without throwing", () => {
    expect(
      verifyLinearSignature({
        signature: "not-hex",
        rawBody: "{}",
        secret: "s",
      }),
    ).toBe(false);
  });
});
