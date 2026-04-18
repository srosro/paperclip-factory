import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySlackSignatureArgs {
  signingSecret: string;
  timestampHeader: string;
  signatureHeader: string;
  rawBody: string;
  nowSec?: number;
  maxSkewSec?: number;
}

/**
 * Verify a Slack webhook signature per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * - Rejects timestamps outside the allowed skew window (default 5 minutes).
 * - Uses constant-time comparison on the HMAC-SHA256 digest.
 */
export function verifySlackSignature(args: VerifySlackSignatureArgs): boolean {
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const maxSkew = args.maxSkewSec ?? 60 * 5;

  const ts = Number(args.timestampHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSec - ts) > maxSkew) return false;

  const base = `v0:${args.timestampHeader}:${args.rawBody}`;
  const expected =
    "v0=" + createHmac("sha256", args.signingSecret).update(base).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(args.signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
