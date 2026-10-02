import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_RANDOM_CHARS } from "@keel/config";

/**
 * MCP secrets (#21): `prefix_` + 32 random base62 characters, shown once. Only HMAC-SHA256 with a
 * server-side pepper is stored, so a leaked database cannot be replayed or brute-forced offline
 * without the pepper. The pepper is `MCP_TOKEN_PEPPER`, else derived from `AUTH_SECRET`.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function pepper(): string {
  const explicit = process.env.MCP_TOKEN_PEPPER?.trim();
  if (explicit) return explicit;
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("MCP_TOKEN_PEPPER or AUTH_SECRET must be set to issue MCP tokens");
  return `keel-mcp-token-pepper:${secret}`;
}

/** Uniform base62 string from rejection sampling (no modulo bias). */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export type McpSecretKind = keyof typeof MCP_TOKEN_PREFIX;

export function newMcpSecret(kind: McpSecretKind): { raw: string; hash: string; displayPrefix: string } {
  const raw = `${MCP_TOKEN_PREFIX[kind]}${randomBase62(MCP_TOKEN_RANDOM_CHARS)}`;
  return { raw, hash: hashMcpSecret(raw), displayPrefix: raw.slice(0, MCP_TOKEN_PREFIX[kind].length + 4) };
}

export function hashMcpSecret(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

/** Shape check before any lookup: known prefix + 32 base62 characters. */
export function isWellFormedMcpSecret(raw: unknown, kind?: McpSecretKind): raw is string {
  if (typeof raw !== "string" || raw.length > 64) return false;
  const kinds = kind ? [kind] : (Object.keys(MCP_TOKEN_PREFIX) as McpSecretKind[]);
  return kinds.some((k) => raw.startsWith(MCP_TOKEN_PREFIX[k]) && new RegExp(`^[0-9A-Za-z]{${MCP_TOKEN_RANDOM_CHARS}}$`).test(raw.slice(MCP_TOKEN_PREFIX[k].length)));
}

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) compared in constant time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
