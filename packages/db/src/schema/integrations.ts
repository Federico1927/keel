import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

/** One row per provider per tenant. Credentials are AES-GCM encrypted (packages/integrations/crypto). */
export const integrations = pgTable(
  "integrations",
  {
    ...tenantColumns(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("not_connected"),
    mode: text("mode").notNull().default("mock"),
    externalAccountId: text("external_account_id"),
    externalAccountName: text("external_account_name"),
    credentialsEncrypted: text("credentials_encrypted"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("integrations_tenant_provider_uq").on(t.tenantId, t.provider), tenantIsolation("integrations")],
).enableRLS();

export const integrationHealth = pgTable(
  "integration_health",
  {
    ...tenantColumns(),
    /** `<provider>` or `<provider>:<account>`. */
    source: text("source").notNull(),
    status: text("status").notNull().default("unknown"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastMetricDate: text("last_metric_date"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    rowsWrittenLast: integer("rows_written_last").notNull().default(0),
    freshnessMinutes: integer("freshness_minutes").notNull().default(60),
    lastError: text("last_error"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("integration_health_tenant_source_uq").on(t.tenantId, t.source), tenantIsolation("integration_health")],
).enableRLS();

/** Inbound webhook log = idempotency store + retry queue + audit. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    ...tenantColumns(),
    source: text("source").notNull(),
    topic: text("topic").notNull(),
    externalId: text("external_id").notNull(),
    sourceUpdatedAt: text("source_updated_at").notNull().default(""),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_events_dedup_uq").on(t.tenantId, t.source, t.topic, t.externalId, t.sourceUpdatedAt),
    index("webhook_events_status_idx").on(t.tenantId, t.status, t.receivedAt),
    tenantIsolation("webhook_events"),
  ],
).enableRLS();

/** Every sync, backfill or reconciliation run writes a row: the evidence trail of the health page. */
export const syncRuns = pgTable(
  "sync_runs",
  {
    ...tenantColumns(),
    provider: text("provider").notNull(),
    objectType: text("object_type").notNull(),
    kind: text("kind").notNull().default("delta"),
    status: text("status").notNull().default("running"),
    cursor: jsonb("cursor").notNull().default(sql`'{}'::jsonb`),
    rowsWritten: integer("rows_written").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("sync_runs_tenant_started_idx").on(t.tenantId, t.startedAt), tenantIsolation("sync_runs")],
).enableRLS();
