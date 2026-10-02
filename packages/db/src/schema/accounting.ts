import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

/**
 * Tables of `addon.accounting` (issue #85), rows only for tenants with the add-on. The daily sales
 * summary itself is computed from orders (core, every tenant) and stores nothing.
 */
export const accountingSettings = pgTable(
  "accounting_settings",
  {
    ...tenantColumns(),
    /** Parsed by `accountingSettingsSchema` (core): account mapping per summary line, start day, look-back, close delay, journal status. */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    /** Chart of accounts last read from the accounting system ("Resync accounts"). */
    accounts: jsonb("accounts").notNull().default(sql`'[]'::jsonb`),
    accountsSyncedAt: timestamp("accounts_synced_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("accounting_settings_tenant_uq").on(t.tenantId), tenantIsolation("accounting_settings")],
).enableRLS();

/**
 * Push log: one row per local day and journal version. The highest version of a day is its current
 * state (`waiting` with reasons, `pushing`, `pushed`, `failed` with the error and the next attempt,
 * `empty` when there is nothing to post); a re-push voids the pushed journal in the accounting
 * system (`voided`, kept for the log) and adds version + 1. The idempotency key sent to the system is
 * tenant + day + version, so a retried push never creates a second journal.
 */
export const accountingJournals = pgTable(
  "accounting_journals",
  {
    ...tenantColumns(),
    /** Local day in the tenant's time zone (YYYY-MM-DD). */
    day: text("day").notNull(),
    version: integer("version").notNull().default(1),
    /** waiting | pushing | pushed | failed | voided | empty */
    status: text("status").notNull().default("waiting"),
    provider: text("provider").notNull(),
    /** Why the day waits: core `AccountingWaitReason[]`. */
    reasons: jsonb("reasons").notNull().default(sql`'[]'::jsonb`),
    /** The journal as built (narration, reference, lines with accounts); kept as pushed. */
    journal: jsonb("journal").notNull().default(sql`'{}'::jsonb`),
    debitMinor: integer("debit_minor").notNull().default(0),
    creditMinor: integer("credit_minor").notNull().default(0),
    currency: text("currency").notNull(),
    /** Day totals at build time: total, fees, net, sale and refund orders. */
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),
    payloadHash: text("payload_hash"),
    externalId: text("external_id"),
    /** Status read back from the accounting system (draft | posted | voided | not_found). */
    externalStatus: text("external_status"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    /** Who asked for a manual re-push or retry (null = the daily tick). */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("accounting_journals_day_version_uq").on(t.tenantId, t.day, t.version),
    index("accounting_journals_status_idx").on(t.tenantId, t.status, t.nextAttemptAt),
    index("accounting_journals_day_idx").on(t.tenantId, t.day),
    tenantIsolation("accounting_journals"),
  ],
).enableRLS();
