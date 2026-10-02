import type { TenantRole } from "./roles";

/**
 * Remote MCP server (#21): scopes a token can carry, limits and token formats. The server checks
 * every call against the scopes, the role × page × action matrix and the modules of the tenant.
 */

/** `read` is the default; each `write:*` unlocks one family of write tools (direct or proposals). */
export const MCP_SCOPES = ["read", "write:notes", "write:orders", "write:campaigns", "write:purchasing"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const MCP_DEFAULT_SCOPES: readonly McpScope[] = ["read"];

export function isMcpScope(v: unknown): v is McpScope {
  return typeof v === "string" && (MCP_SCOPES as readonly string[]).includes(v);
}

/**
 * Roles that may ever see customer PII (names, emails, phones, addresses) through MCP, and only
 * when the tenant switched full PII on. Everyone else always gets masked values.
 */
export const MCP_PII_ROLES: readonly TenantRole[] = ["owner", "admin", "operations", "customer_care"];

export const MCP_LIMITS = {
  /** Calls per token per minute (tools/list, tools/call, initialize alike). */
  perTokenPerMinute: 60,
  /** Calls per tenant per minute, all tokens together. */
  perTenantPerMinute: 300,
  /** Largest page a list tool returns. */
  maxPageSize: 50,
  /** Free-text search input, after sanitising. */
  searchMaxChars: 80,
  /** Free text written by a tool (a note, a reason). */
  textMaxChars: 1000,
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlDays: 30,
  authCodeTtlSeconds: 300,
  /** Personal access tokens: default and maximum lifetime. */
  patDefaultDays: 90,
  patMaxDays: 365,
  /** Proposals nobody decided on expire. */
  proposalTtlDays: 7,
  /** Dynamic client registrations per IP per hour. */
  registrationsPerIpPerHour: 20,
  /** Active personal access tokens per user per tenant. */
  patsPerUser: 10,
} as const;

/** Lifetimes a person can pick for a personal access token. */
export const MCP_PAT_DAYS = [30, 90, 180, 365] as const;

/** Token formats: a fixed prefix + 32 random base62 characters. Only an HMAC of the whole token is stored. */
export const MCP_TOKEN_PREFIX = { pat: "kpat_", access: "kat_", refresh: "krt_", code: "kac_" } as const;
export const MCP_TOKEN_RANDOM_CHARS = 32;
