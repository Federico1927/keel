/**
 * Public REST API and outgoing webhooks (#81): token scopes, limits, event types and retry schedule.
 * The API uses the same tokens as the MCP server (personal access tokens, OAuth grants): a token's
 * `scopes` column holds MCP scopes and API scopes side by side; each server reads only its own.
 */

/**
 * API scopes, one per resource family and direction. Nothing is implied: a token reads orders only
 * with `orders:read`, even if it can write them. `pii:read` adds customer personal data (names,
 * emails, phones, street addresses) to responses, for roles that may see it and only when the
 * tenant switched full PII on; otherwise those fields are masked as on MCP.
 */
export const API_SCOPES = [
  "orders:read",
  "orders:write",
  "customers:read",
  "products:read",
  "inventory:read",
  "inventory:write",
  "shipments:read",
  "returns:read",
  "discounts:read",
  "purchasing:read",
  "webhooks:manage",
  "pii:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}

export const API_LIMITS = {
  /** Requests per token per minute. */
  perTokenPerMinute: 120,
  /** Requests per tenant per minute, all tokens together. */
  perTenantPerMinute: 600,
  /** Largest page (`limit`) of a list endpoint. */
  maxPageSize: 100,
  defaultPageSize: 25,
  /** How long a stored `Idempotency-Key` answer is replayed. */
  idempotencyTtlHours: 24,
  /** Largest JSON body a write accepts. */
  maxBodyBytes: 64 * 1024,
  /** Personal access tokens with API scopes per user per tenant (shared with MCP tokens). */
  tokenDays: [30, 90, 180, 365] as const,
} as const;

/** Event types a webhook endpoint can subscribe to. */
export const WEBHOOK_EVENT_TYPES = ["order.created", "order.updated", "order.status_changed", "shipment.updated", "return.updated", "inventory.low_stock", "product.updated"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(v: unknown): v is WebhookEventType {
  return typeof v === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * Delay before each retry, in seconds: 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h. After the last
 * one fails the delivery is dead (kept in the log, redeliverable by hand).
 */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS = [10, 30, 120, 600, 1800, 3600, 7200] as const;

export const WEBHOOK_LIMITS = {
  endpointsPerTenant: 10,
  /** Whole request, connection included. */
  timeoutMs: 10_000,
  /** Signatures older than this are rejected by the verification snippet. */
  signatureToleranceSeconds: 300,
  /** After a secret rotation the old secret still signs (second `v1=`) for this long. */
  rotationGraceHours: 24,
  /** Response body kept in the delivery log (characters). */
  responseExcerptChars: 300,
  /** A delivery left `sending` longer than this was interrupted and is retried. */
  lockSeconds: 60,
} as const;

/** Headers of every delivery (no product name, so receivers can be written once). */
export const WEBHOOK_HEADERS = { id: "Webhook-Id", event: "Webhook-Event", timestamp: "Webhook-Timestamp", signature: "Webhook-Signature" } as const;

/** Webhook secrets: a fixed prefix + 32 random base62 characters, stored encrypted (AES-GCM). */
export const WEBHOOK_SECRET_PREFIX = "whsec_";
