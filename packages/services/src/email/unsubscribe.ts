import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@hullwise/config";
import { encryptionKeyStrings } from "@hullwise/integrations";

/** Origin of the tenant app for links in emails and notifications (APP_URL, see @hullwise/config urls). */
export function appBaseUrl(): string {
  return appUrl();
}

/* ---------- signed unsubscribe links ---------- */

export interface UnsubscribePayload {
  tenantId: string;
  email: string;
  category: string;
}

/** Current signing secret first; APP_ENCRYPTION_KEY_PREVIOUS too during a key rotation, so links in emails already sent keep working. */
function signingSecrets(): string[] {
  const keys = encryptionKeyStrings();
  const s = keys.length ? keys : process.env.AUTH_SECRET ? [process.env.AUTH_SECRET] : [];
  if (!s.length) throw new Error("APP_ENCRYPTION_KEY or AUTH_SECRET is required to sign unsubscribe links");
  return s;
}
const mac = (body: string, secret = signingSecrets()[0]!) => createHmac("sha256", `unsubscribe:${secret}`).update(body).digest("base64url").slice(0, 32);

/** `<base64url(json)>.<hmac>`: per recipient and category, no expiry (unsubscribe links must keep working). */
export function signUnsubscribeToken(p: UnsubscribePayload): string {
  const body = Buffer.from(JSON.stringify({ t: p.tenantId, e: p.email.trim().toLowerCase(), c: p.category })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 2000) return null;
  const given = Buffer.from(sig);
  const valid = signingSecrets().some((secret) => {
    const expected = Buffer.from(mac(body, secret));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!valid) return null;
  try {
    const j = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { t?: unknown; e?: unknown; c?: unknown };
    if (typeof j.t !== "string" || !/^[0-9a-f-]{36}$/i.test(j.t) || typeof j.e !== "string" || typeof j.c !== "string") return null;
    return { tenantId: j.t, email: j.e, category: j.c };
  } catch {
    return null;
  }
}

/** Link in the email body: a page that asks for confirmation. */
export function unsubscribeUrl(p: UnsubscribePayload): string {
  return `${appBaseUrl()}/u/${signUnsubscribeToken(p)}`;
}

/** `List-Unsubscribe` header target: RFC 8058 one-click POST. */
export function oneClickUnsubscribeUrl(p: UnsubscribePayload): string {
  return `${appBaseUrl()}/api/email/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(p))}`;
}
