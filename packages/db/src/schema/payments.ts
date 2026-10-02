import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { orders } from "./orders";

/**
 * Money Keel moved on an order after checkout (issue #27): manual payments recorded by staff and
 * refunds issued from the order page. The order row keeps the totals (`refunded_minor`,
 * `payment_status`); these rows are the ledger behind them, with author and platform reference.
 */
export const orderTransactions = pgTable(
  "order_transactions",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** manual_payment | refund */
    kind: text("kind").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    /** Canonical payment method of a manual payment (card, wallet, bank_transfer, cod, bnpl, other). */
    method: text("method"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    note: text("note"),
    /** Refunded lines: [{ orderLineId, quantity, restock }]. */
    lines: jsonb("lines").notNull().default(sql`'[]'::jsonb`),
    restockLocationId: uuid("restock_location_id"),
    /** Refund id on the platform, when it has one. */
    externalId: text("external_id"),
    /** Amount asked for, when the platform accepted less (capped by what was captured). */
    requestedMinor: integer("requested_minor"),
    writtenToPlatform: boolean("written_to_platform").notNull().default(false),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("user"),
    createdAt: createdAt(),
  },
  (t) => [index("order_transactions_order_idx").on(t.tenantId, t.orderId), index("order_transactions_occurred_idx").on(t.tenantId, t.occurredAt), tenantIsolation("order_transactions")],
).enableRLS();

/** Deposits of the platform's payment processor (Shopify Payments) to the merchant's bank. */
export const payouts = pgTable(
  "payouts",
  {
    ...tenantColumns(),
    provider: text("provider").notNull().default("shopify"),
    externalId: text("external_id").notNull(),
    /** scheduled | in_transit | paid | failed | canceled */
    status: text("status").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    currency: text("currency").notNull(),
    grossMinor: integer("gross_minor").notNull().default(0),
    refundsMinor: integer("refunds_minor").notNull().default(0),
    adjustmentsMinor: integer("adjustments_minor").notNull().default(0),
    feeMinor: integer("fee_minor").notNull().default(0),
    netMinor: integer("net_minor").notNull().default(0),
    transactionCount: integer("transaction_count").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("payouts_tenant_provider_external_uq").on(t.tenantId, t.provider, t.externalId), index("payouts_tenant_issued_idx").on(t.tenantId, t.issuedAt), tenantIsolation("payouts")],
).enableRLS();

/** Movements of the processor balance with the actual fee: the P/L takes an order's fee from here when known. */
export const balanceTransactions = pgTable(
  "balance_transactions",
  {
    ...tenantColumns(),
    provider: text("provider").notNull().default("shopify"),
    externalId: text("external_id").notNull(),
    payoutId: uuid("payout_id").references(() => payouts.id, { onDelete: "set null" }),
    payoutExternalId: text("payout_external_id"),
    /** charge | refund | adjustment | dispute | reserve | other */
    type: text("type").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    orderExternalId: text("order_external_id"),
    amountMinor: integer("amount_minor").notNull(),
    feeMinor: integer("fee_minor").notNull().default(0),
    netMinor: integer("net_minor").notNull(),
    currency: text("currency").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("balance_transactions_tenant_provider_external_uq").on(t.tenantId, t.provider, t.externalId),
    index("balance_transactions_order_idx").on(t.tenantId, t.orderId),
    index("balance_transactions_payout_idx").on(t.tenantId, t.payoutId),
    index("balance_transactions_order_external_idx").on(t.tenantId, t.orderExternalId),
    tenantIsolation("balance_transactions"),
  ],
).enableRLS();
