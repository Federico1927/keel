import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-time sign-in grant (#52): after accepting an invitation or resetting a password, the server
 * action signs the person in without asking for the password again. The grant is an HMAC (AUTH_SECRET)
 * over user, session version and a 60-second expiry; it is created and consumed inside the same
 * server action (Auth.js `signIn` runs in process), so it never reaches the browser. The session
 * version ties it to the account state: after another reset it no longer works.
 */
const TTL_MS = 60_000;

function key(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return `sign-in-grant:${secret}`;
}

const mac = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

export function createSignInGrant(userId: string, sessionVersion: number, now = Date.now()): string {
  const payload = `${userId}.${sessionVersion}.${now + TTL_MS}`;
  return `${payload}.${mac(payload)}`;
}

export function verifySignInGrant(grant: unknown, now = Date.now()): { userId: string; sessionVersion: number } | null {
  if (typeof grant !== "string" || grant.length > 300) return null;
  const parts = grant.split(".");
  if (parts.length !== 4) return null;
  const [userId, sv, exp, sig] = parts as [string, string, string, string];
  const expected = Buffer.from(mac(`${userId}.${sv}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < now || !/^\d+$/.test(sv)) return null;
  return { userId, sessionVersion: Number(sv) };
}
