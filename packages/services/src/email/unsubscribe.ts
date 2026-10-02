import { createHmac, timingSafeEqual } from "node:crypto";

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/* ---------- signed unsubscribe links ---------- */

export interface UnsubscribePayload {
  tenantId: string;
  email: string;
  category: string;
}

function signingSecret(): string {
  const s = process.env.APP_ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!s) throw new Error("APP_ENCRYPTION_KEY or AUTH_SECRET is required to sign unsubscribe links");
  return s;
}
const mac = (body: string) => createHmac("sha256", `unsubscribe:${signingSecret()}`).update(body).digest("base64url").slice(0, 32);

/** `<base64url(json)>.<hmac>`: per recipient and category, no expiry (unsubscribe links must keep working). */
export function signUnsubscribeToken(p: UnsubscribePayload): string {
  const body = Buffer.from(JSON.stringify({ t: p.tenantId, e: p.email.trim().toLowerCase(), c: p.category })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 2000) return null;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
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
