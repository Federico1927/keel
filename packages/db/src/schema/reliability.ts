import { sql } from "drizzle-orm";
import { customType, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, hullwiseApp, tenantIsolation, tenantPredicate, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { tenants } from "./tenants";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * Job run history (#32): one row per execution of a background job, written by the worker around
 * every handler (and by "run now" from the console). Tenant jobs carry the tenant; scheduler ticks
 * and platform housekeeping have none. Written and read through the admin connection; a tenant may
 * read its own rows (RLS), never change them.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** Queue the job came from (`sync.ads`, `scheduler.tick`, …). */
    queue: text("queue").notNull(),
    /** What ran: the queue, or `tick:<kind>` for scheduler ticks, or a service step (`audit.retention`). */
    jobType: text("job_type").notNull(),
    /** schedule | queue | manual | inline */
    trigger: text("trigger").notNull().default("queue"),
    /** running | succeeded | failed */
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    /** Rows the job wrote or deleted, when it reports them. */
    rows: integer("rows"),
    error: text("error"),
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),
    /** The super-admin who pressed "run now". */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("job_runs_type_started_idx").on(t.jobType, t.startedAt),
    index("job_runs_tenant_started_idx").on(t.tenantId, t.startedAt),
    index("job_runs_started_idx").on(t.startedAt),
    pgPolicy("job_runs_tenant_select", { for: "select", to: hullwiseApp, using: tenantPredicate }),
    pgPolicy("job_runs_tenant_insert", { for: "insert", to: hullwiseApp, withCheck: tenantPredicate }),
  ],
).enableRLS();

/**
 * Platform failure alerts (#32): a job type failing N runs in a row, or an integration source with
 * no success inside its freshness window. One row per signature (kind, tenant, job type or source):
 * repeated failures bump it, notifications go out at most once per window, a success resolves it.
 */
export const platformAlerts = pgTable(
  "platform_alerts",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    signature: text("signature").notNull(),
    /** job_failure | sync_stale */
    kind: text("kind").notNull(),
    /** Job type or integration source. */
    subject: text("subject").notNull(),
    /** open | resolved */
    status: text("status").notNull().default("open"),
    occurrences: integer("occurrences").notNull().default(1),
    lastError: text("last_error"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    notifiedCount: integer("notified_count").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** auto (the job or source recovered) or the super-admin who closed it. */
    resolvedBy: text("resolved_by"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("platform_alerts_signature_uq").on(t.signature),
    index("platform_alerts_status_seen_idx").on(t.status, t.lastSeenAt),
    index("platform_alerts_tenant_idx").on(t.tenantId, t.lastSeenAt),
    pgPolicy("platform_alerts_tenant_select", { for: "select", to: hullwiseApp, using: tenantPredicate }),
    pgPolicy("platform_alerts_tenant_insert", { for: "insert", to: hullwiseApp, withCheck: tenantPredicate }),
  ],
).enableRLS();

/**
 * Full data export of one tenant (#32: GDPR requests, a churned tenant leaving): a background job
 * writes one CSV per tenant table, read inside the tenant's RLS transaction, into a zip kept here
 * until `expires_at`; then the file is deleted and the row stays as the record.
 */
export const tenantDataExports = pgTable(
  "tenant_data_exports",
  {
    ...tenantColumns(),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** owner | super_admin | system (a privacy request received from the platform) */
    requestedByType: text("requested_by_type").notNull().default("owner"),
    /** tenant (every table, #32) | customer (one customer's data: a GDPR access request) */
    scope: text("scope").notNull().default("tenant"),
    /** The customer a `customer` export is about (no FK: the record outlives an erased or deleted customer). */
    subjectCustomerId: uuid("subject_customer_id"),
    /** What a `customer` export covers when the customer is unknown or a guest: platform ids, the request reference. */
    subject: jsonb("subject").$type<{ customerExternalId?: string | null; orderExternalIds?: string[]; requestRef?: string | null }>(),
    /** pending | running | done | failed | expired */
    status: text("status").notNull().default("pending"),
    /** Rows per exported table. */
    tables: jsonb("tables").notNull().default(sql`'{}'::jsonb`),
    rowCount: integer("row_count"),
    fileName: text("file_name"),
    file: bytea("file"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
    downloadCount: integer("download_count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [index("tenant_data_exports_tenant_created_idx").on(t.tenantId, t.createdAt), tenantIsolation("tenant_data_exports")],
).enableRLS();

/**
 * Deletion of a whole tenant from the console: a platform row with no foreign key to `tenants`, so the
 * record (who, when, what was deleted, row counts) survives the tenant. The background job
 * `tenant.delete` disconnects the integrations, cancels the subscription, deletes the rows table by
 * table (progress in `steps`) and finally the tenant itself. Admin connection only.
 */
export const tenantDeletions = pgTable(
  "tenant_deletions",
  {
    id: id(),
    /** The deleted tenant's id (kept as a plain value). */
    tenantRef: uuid("tenant_ref").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    /** pending | running | done | failed */
    status: text("status").notNull().default("pending"),
    /** Rows per table counted when asked. */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    /** Done steps: `disconnect:<provider>`, `billing`, `table:<name>` with the rows deleted, `tenant`. */
    steps: jsonb("steps").$type<{ step: string; rows?: number; note?: string; at: string }[]>().notNull().default(sql`'[]'::jsonb`),
    totalSteps: integer("total_steps").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [index("tenant_deletions_tenant_idx").on(t.tenantRef, t.createdAt), index("tenant_deletions_created_idx").on(t.createdAt)],
).enableRLS(); // no policy: the application role sees nothing
