import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { locations, productVariants } from "./catalog";

/**
 * Stock-take sessions (issue #30): one location, counted quantities typed or scanned, partial
 * counts allowed. Applying writes one `adjustment` movement (reason code `count_correction`) per
 * difference, all in one transaction and referenced by the session id.
 */
export const stockTakes = pgTable(
  "stock_takes",
  {
    ...tenantColumns(),
    number: integer("number").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** open | applied | cancelled */
    status: text("status").notNull().default("open"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    appliedBy: uuid("applied_by").references(() => users.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** Movements written when applied (counts of the review at that moment). */
    appliedMovements: integer("applied_movements"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("stock_takes_tenant_number_uq").on(t.tenantId, t.number), index("stock_takes_tenant_status_idx").on(t.tenantId, t.status, t.createdAt), tenantIsolation("stock_takes")],
).enableRLS();

export const stockTakeCounts = pgTable(
  "stock_take_counts",
  {
    ...tenantColumns(),
    stockTakeId: uuid("stock_take_id")
      .notNull()
      .references(() => stockTakes.id, { onDelete: "cascade" }),
    /** Null when the code matched no variant (shown as unknown SKU, never applied). */
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    /** What was typed or scanned (SKU or barcode). */
    code: text("code").notNull(),
    counted: integer("counted").notNull().default(0),
    /** Snapshot when the session is applied: level before and the correction written. */
    expectedAtApply: integer("expected_at_apply"),
    appliedDelta: integer("applied_delta"),
    countedBy: uuid("counted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("stock_take_counts_variant_uq").on(t.stockTakeId, t.variantId), index("stock_take_counts_take_idx").on(t.tenantId, t.stockTakeId), tenantIsolation("stock_take_counts")],
).enableRLS();

/**
 * Price history of variants for the changes Keel makes (markdowns, bulk and single price edits):
 * before and after for price and compare-at price, who, from where, and the batch.
 */
export const priceChanges = pgTable(
  "price_changes",
  {
    ...tenantColumns(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    priceBeforeMinor: integer("price_before_minor").notNull(),
    priceAfterMinor: integer("price_after_minor").notNull(),
    compareAtBeforeMinor: integer("compare_at_before_minor"),
    compareAtAfterMinor: integer("compare_at_after_minor"),
    /** markdown | bulk | manual */
    source: text("source").notNull(),
    batchId: uuid("batch_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("price_changes_variant_idx").on(t.tenantId, t.variantId, t.createdAt), index("price_changes_tenant_source_idx").on(t.tenantId, t.source, t.createdAt), tenantIsolation("price_changes")],
).enableRLS();
