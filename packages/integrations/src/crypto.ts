import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM with the key from APP_ENCRYPTION_KEY (base64, 32 bytes). Output: base64(iv|tag|ciphertext).
 * Key rotation (docs/DEPLOY.md, "Rotating secrets"): while APP_ENCRYPTION_KEY_PREVIOUS holds the old key,
 * payloads it encrypted still decrypt, and `pnpm db:rotate-key` re-encrypts them with the new one.
 */
function parseKey(name: string, raw: string): Buffer {
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return buf;
}
function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not set");
  return parseKey("APP_ENCRYPTION_KEY", raw);
}
/** The key being rotated away from, or null outside a rotation window. */
function previousKey(): Buffer | null {
  const raw = process.env.APP_ENCRYPTION_KEY_PREVIOUS?.trim();
  return raw ? parseKey("APP_ENCRYPTION_KEY_PREVIOUS", raw) : null;
}

/** Whether APP_ENCRYPTION_KEY_PREVIOUS is set (a rotation is in progress). */
export function hasPreviousEncryptionKey(): boolean {
  return previousKey() !== null;
}

/**
 * The raw key strings that may verify a keyed token derived from APP_ENCRYPTION_KEY (webhook URL
 * tokens, unsubscribe links): the current one first, then APP_ENCRYPTION_KEY_PREVIOUS when set.
 * `fallback` stands in for a missing current key (development only).
 */
export function encryptionKeyStrings(fallback?: string): string[] {
  const current = process.env.APP_ENCRYPTION_KEY || fallback;
  const previous = process.env.APP_ENCRYPTION_KEY_PREVIOUS?.trim();
  return [...(current ? [current] : []), ...(previous && previous !== current ? [previous] : [])];
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptWith(k: Buffer, payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Decrypts with the current key, then with APP_ENCRYPTION_KEY_PREVIOUS when set; throws when neither opens it. */
export function decryptSecret(payload: string): string {
  try {
    return decryptWith(key(), payload);
  } catch (e) {
    const prev = previousKey();
    if (!prev) throw e;
    return decryptWith(prev, payload);
  }
}

/** Which key opens a stored payload: `current`, `previous` (needs re-encryption) or null (neither: lost or corrupt). */
export function encryptionKeyOf(payload: string): "current" | "previous" | null {
  try {
    decryptWith(key(), payload);
    return "current";
  } catch {
    const prev = previousKey();
    if (!prev) return null;
    try {
      decryptWith(prev, payload);
      return "previous";
    } catch {
      return null;
    }
  }
}

/**
 * Key rotation step for one stored payload: unchanged when the current key already opens it
 * (so running the rotation twice is a no-op), re-encrypted with the current key when only the
 * previous one does. Throws when neither key opens it.
 */
export function reencryptSecret(payload: string): { payload: string; changed: boolean } {
  const which = encryptionKeyOf(payload);
  if (which === "current") return { payload, changed: false };
  if (which === "previous") return { payload: encryptSecret(decryptSecret(payload)), changed: true };
  throw new Error("payload opens with neither APP_ENCRYPTION_KEY nor APP_ENCRYPTION_KEY_PREVIOUS");
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

const addressHashWith = (k: Buffer, email: string) => createHmac("sha256", Buffer.concat([Buffer.from("email-address:"), k])).update(normalizeEmailAddress(email)).digest("hex");

/**
 * Keyed hash (HMAC-SHA256 with APP_ENCRYPTION_KEY) of a normalized address: the delivery log and
 * the platform suppression list match recipients without storing them. Rotating the key changes
 * every hash: lookups use `emailAddressHashes` during the rotation window, and `pnpm db:rotate-key`
 * re-hashes the suppressions of the addresses it can find (docs/DEPLOY.md, "Rotating secrets").
 */
export function emailAddressHash(email: string): string {
  return addressHashWith(key(), email);
}

/** The address's hash with the current key, then with APP_ENCRYPTION_KEY_PREVIOUS when set: what a lookup must match. */
export function emailAddressHashes(email: string): string[] {
  const prev = previousKey();
  return prev ? [emailAddressHash(email), addressHashWith(prev, email)] : [emailAddressHash(email)];
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

const stateKey = (k: Buffer = key()) => Buffer.concat([Buffer.from("signed-state:"), k]);

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
  const prev = previousKey();
  const matches = (k: Buffer) => {
    const expected = createHmac("sha256", stateKey(k)).update(body).digest("base64url");
    return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  };
  // a state signed just before a key rotation still verifies with the previous key
  if (!matches(key()) && !(prev && matches(prev))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number; n: string };
    return typeof payload.exp === "number" && payload.exp * 1000 >= now ? payload : null;
  } catch {
    return null;
  }
}
