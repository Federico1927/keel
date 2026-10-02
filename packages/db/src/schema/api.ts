import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

/**
 * Public REST API and outgoing webhooks (#81). Tokens are the MCP ones (`mcp_tokens`, API scopes in
 * the same `scopes` column); rate windows reuse `mcp_rate_buckets` with `api:` buckets.
 */

/** Where a tenant wants its events: an https URL, the signing secret (AES-GCM) and the event types. */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    ...tenantColumns(),
    url: text("url").notNull(),
    description: text("description"),
    /** `whsec_…`, encrypted with APP_ENCRYPTION_KEY; shown once at creation and rotation. */
    secretEnc: text("secret_enc").notNull(),
    /** First characters of the secret, for the UI. */
    secretPrefix: text("secret_prefix").notNull(),
    /** After a rotation the previous secret signs too (second `v1=`) until `previous_secret_expires_at`. */
    previousSecretEnc: text("previous_secret_enc"),
    previousSecretExpiresAt: timestamp("previous_secret_expires_at", { withTimezone: true }),
    secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }).notNull().defaultNow(),
    eventTypes: text("event_types").array().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhook_endpoints_tenant_idx").on(t.tenantId, t.createdAt), tenantIsolation("webhook_endpoints")],
).enableRLS();

/**
 * One event for one endpoint. `status` = pending | sending | retrying | succeeded | dead | cancelled.
 * A redelivery is a new row with the same `event_id` (and `redelivery_of`). `attempt_log` keeps the
 * last attempts (time, HTTP status, duration, error), never the response headers.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    ...tenantColumns(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseCode: integer("response_code"),
    durationMs: integer("duration_ms"),
    lastError: text("last_error"),
    responseExcerpt: text("response_excerpt"),
    attemptLog: jsonb("attempt_log").notNull().default(sql`'[]'::jsonb`),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    redeliveryOf: uuid("redelivery_of"),
    isTest: boolean("is_test").notNull().default(false),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("webhook_deliveries_tenant_idx").on(t.tenantId, t.createdAt),
    index("webhook_deliveries_endpoint_idx").on(t.tenantId, t.endpointId, t.createdAt),
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_event_idx").on(t.tenantId, t.eventId),
    tenantIsolation("webhook_deliveries"),
  ],
).enableRLS();

/** Stored answers of API writes sent with an `Idempotency-Key` (per token), replayed for 24 hours. */
export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    ...tenantColumns(),
    tokenId: uuid("token_id").notNull(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    /** SHA-256 of method, path and body: the same key with another request is refused. */
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("api_idempotency_keys_uq").on(t.tenantId, t.tokenId, t.key), index("api_idempotency_keys_expiry_idx").on(t.tenantId, t.expiresAt), tenantIsolation("api_idempotency_keys")],
).enableRLS();

/** One row per authenticated API request (method, route, status, duration): never query values or bodies. */
export const apiRequestLog = pgTable(
  "api_request_log",
  {
    ...tenantColumns(),
    tokenId: uuid("token_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    /** The route pattern (`/v1/orders/{id}`), not the concrete path. */
    route: text("route").notNull(),
    status: integer("status").notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("api_request_log_tenant_idx").on(t.tenantId, t.createdAt), tenantIsolation("api_request_log")],
).enableRLS();
