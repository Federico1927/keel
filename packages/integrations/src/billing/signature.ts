import { createHmac, timingSafeEqual } from "node:crypto";

export type StripeSignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: "missing_header" | "malformed" | "timestamp_out_of_tolerance" | "signature_mismatch" };

/**
 * `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`: HMAC-SHA256 of `<t>.<raw body>` keyed with the
 * endpoint secret, compared in constant time; timestamps outside the tolerance are refused (replay).
 */
export function verifyStripeSignature(header: string | null | undefined, rawBody: string, secret: string, opts: { toleranceSeconds?: number; now?: number } = {}): StripeSignatureCheck {
  if (!header) return { ok: false, reason: "missing_header" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v!);
  if (!Number.isFinite(t) || t <= 0 || !sigs.length) return { ok: false, reason: "malformed" };
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex"), "utf8");
  const match = sigs.some((s) => {
    const got = Buffer.from(s, "utf8");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true, timestamp: t } : { ok: false, reason: "signature_mismatch" };
}

/** Builds the header Stripe would send (tests, the mock's simulated webhooks). */
export function signStripePayload(rawBody: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSeconds},v1=${createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex")}`;
}
