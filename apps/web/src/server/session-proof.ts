/**
 * Proof that a session-version update came from the server. Auth.js lets any client call the
 * session endpoint with an `update` payload, so the JWT callback only accepts a new session
 * version together with an HMAC over it made with AUTH_SECRET (Web Crypto: edge and node).
 */
const enc = new TextEncoder();

async function key(): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
  return crypto.subtle.importKey("raw", enc.encode(`session-version:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function signSessionVersion(userId: string, version: number): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await key(), enc.encode(`${userId}:${version}`)));
}

export async function verifySessionVersion(userId: string, version: unknown, proof: unknown): Promise<boolean> {
  if (typeof version !== "number" || !Number.isInteger(version) || typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  const bytes = new Uint8Array(proof.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await key(), bytes, enc.encode(`${userId}:${version}`));
}
