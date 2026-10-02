import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

/**
 * Ad accounts of a platform that allows several per store (Meta, #82). The integration row stays the
 * platform connection; its account is mirrored here as the primary one (`is_primary`), the others are
 * added from the integrations card. Each account has its own credentials reference (null: the
 * integration's token, which a Business Manager system user shares across accounts), sync cursor,
 * status and last error. Removing an account keeps the row as `not_connected`, so its campaigns keep a name.
 */
export const adAccounts = pgTable(
  "ad_accounts",
  {
    ...tenantColumns(),
    provider: text("provider").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    name: text("name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** not_connected | connected | error | syncing */
    status: text("status").notNull().default("connected"),
    mode: text("mode").notNull().default("mock"),
    credentialsEncrypted: text("credentials_encrypted"),
    /** Last window pulled `{ since, until }` and the last metric day: the account's own sync cursor. */
    cursor: jsonb("cursor").notNull().default(sql`'{}'::jsonb`),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ad_accounts_uq").on(t.tenantId, t.provider, t.externalAccountId), index("ad_accounts_tenant_idx").on(t.tenantId, t.provider, t.status), tenantIsolation("ad_accounts")],
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
    /** Successful runs in a row that wrote no rows (idle after N, per provider; #32). */
    zeroRowRuns: integer("zero_row_runs").notNull().default(0),
    /** Watchdog (#32): last owner/admin notification and last automatic resync for this source. */
    watchdogNotifiedAt: timestamp("watchdog_notified_at", { withTimezone: true }),
    resyncRequestedAt: timestamp("resync_requested_at", { withTimezone: true }),
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
    /** Objects changed (created, updated, zeroed). */
    rowsWritten: integer("rows_written").notNull().default(0),
    /** Objects read from the platform. */
    rowsScanned: integer("rows_scanned").notNull().default(0),
    /** Platform values that disagreed with what Hullwise expected (drift, a Hullwise write not yet confirmed). */
    conflicts: integer("conflicts").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    /** Working time summed over the resumed slices of the run. */
    durationMs: integer("duration_ms"),
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("sync_runs_tenant_started_idx").on(t.tenantId, t.startedAt), tenantIsolation("sync_runs")],
).enableRLS();

/**
 * Outbound write outbox: every write to a commerce or ads platform is a row here, keyed for
 * idempotency, executed by a job (or inline when no worker runs), retried with backoff.
 * `mode = sync` rows record writes a flow needed an immediate answer for (executed in the request).
 */
export const platformWrites = pgTable(
  "platform_writes",
  {
    ...tenantColumns(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    mode: text("mode").notNull().default("async"),
    /** Hullwise record the write belongs to (for the status badge). */
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    /** Platform object written (`variant:<id>`, `inventory:<item>@<location>`…): newer writes supersede older pending ones on the same target. */
    targetKey: text("target_key").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** pending | running | succeeded | failed | superseded */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
    result: jsonb("result"),
    actorType: text("actor_type").notNull().default("system"),
    actorUserId: uuid("actor_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("platform_writes_idempotency_uq").on(t.tenantId, t.idempotencyKey),
    index("platform_writes_due_idx").on(t.tenantId, t.status, t.nextAttemptAt),
    index("platform_writes_entity_idx").on(t.tenantId, t.entityType, t.entityId, t.createdAt),
    index("platform_writes_target_idx").on(t.tenantId, t.targetKey, t.createdAt),
    tenantIsolation("platform_writes"),
  ],
).enableRLS();
