import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** AES-256-GCM with the key from APP_ENCRYPTION_KEY (base64, 32 bytes). Output: base64(iv|tag|ciphertext). */
function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}
export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}

/** Lower-cased, trimmed address: the form every email lookup uses. */
export function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Keyed hash (HMAC-SHA256 with APP_ENCRYPTION_KEY) of a normalized address: the delivery log and
 * the platform suppression list match recipients without storing them. Rotating the key makes
 * existing hashes unmatchable (documented in DECISIONS, 2026-10-01 email).
 */
export function emailAddressHash(email: string): string {
  return createHmac("sha256", Buffer.concat([Buffer.from("email-address:"), key()])).update(normalizeEmailAddress(email)).digest("hex");
}

/** `owner@northwind.demo` → `ow•••@no•••.demo`: enough for support to recognise an address, not to read it. */
export function maskEmail(email: string): string {
  const e = normalizeEmailAddress(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, Math.min(2, local.length - 1) || 1)}•••@${host.slice(0, 2)}•••${tld}`;
}

const stateKey = () => Buffer.concat([Buffer.from("signed-state:"), key()]);

/**
 * A tamper-proof, expiring token carrying a small payload (OAuth `state`): base64url(JSON) + "." +
 * HMAC-SHA256 with APP_ENCRYPTION_KEY. Not encrypted: never put a secret in it. Works across hosts
 * (no cookie), so the API host can resolve the tenant of a callback on its own.
 */
export function signState(payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds, n: randomBytes(8).toString("hex") }), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", stateKey()).update(body).digest("base64url")}`;
}

/** The payload of a token made by `signState`, or null when it is malformed, forged or expired. */
export function verifyState<T extends Record<string, unknown>>(token: string | null | undefined, now = Date.now()): (T & { exp: number; n: string }) | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateKey()).update(body).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number; n: string };
    return typeof payload.exp === "number" && payload.exp * 1000 >= now ? payload : null;
  } catch {
    return null;
  }
}
