import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Account tokens (#52): 32 random bytes (base64url) handed out once in a link; only the SHA-256
 * is stored. Rows are found by the hash, then compared again in constant time.
 */
export const TOKEN_BYTES = 32;

export function hashAccountToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newAccountToken(): { raw: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashAccountToken(raw) };
}

/** A raw token as it can appear in a link: base64url of 32+ bytes, bounded. */
export function isWellFormedToken(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length >= 43 && raw.length <= 200 && /^[A-Za-z0-9_-]+$/.test(raw);
}

export function sameTokenHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Keyed hash of a client IP for rate limits (never stored in clear). */
export function ipHash(ip: string | null | undefined): string | null {
  const v = ip?.trim();
  if (!v) return null;
  return createHmac("sha256", `ip:${process.env.AUTH_SECRET ?? process.env.APP_ENCRYPTION_KEY ?? "keel"}`).update(v).digest("hex");
}
