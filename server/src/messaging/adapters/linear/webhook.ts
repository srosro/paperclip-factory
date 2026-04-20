import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linear signs webhook requests with HMAC-SHA256 of the raw request body,
 * using the webhook secret configured on the OAuth app (or the per-install
 * secret returned from webhookCreate). The signature lands in the
 * `Linear-Signature` header as a lowercase hex string.
 */
export function verifyLinearSignature(args: {
  signature: string;
  rawBody: string | Buffer;
  secret: string;
}): boolean {
  if (!args.signature) return false;
  const hmac = createHmac("sha256", args.secret);
  hmac.update(
    typeof args.rawBody === "string"
      ? Buffer.from(args.rawBody, "utf8")
      : args.rawBody,
  );
  const expected = hmac.digest("hex");
  try {
    const a = Buffer.from(args.signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
