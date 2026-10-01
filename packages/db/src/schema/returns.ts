import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { orderLines, orders } from "./orders";
import { locations } from "./catalog";
import { users } from "./auth";

export const returnReasons = pgTable(
  "return_reasons",
  {
    ...tenantColumns(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    /** merchant | customer | undetermined */
    defaultFault: text("default_fault").notNull().default("undetermined"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("return_reasons_tenant_code_uq").on(t.tenantId, t.code), tenantIsolation("return_reasons")],
).enableRLS();

export const returnRequests = pgTable(
  "return_requests",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    externalId: text("external_id"),
    status: text("status").notNull().default("requested"),
    reasonCode: text("reason_code").notNull(),
    resolution: text("resolution").notNull().default("refund"),
    fault: text("fault").notNull().default("undetermined"),
    customerNote: text("customer_note"),
    staffNote: text("staff_note"),
    proposedAmountMinor: integer("proposed_amount_minor").notNull().default(0),
    refundedAmountMinor: integer("refunded_amount_minor"),
    voucherCode: text("voucher_code"),
    exchangeOrderId: uuid("exchange_order_id"),
    restockLocationId: uuid("restock_location_id").references(() => locations.id, { onDelete: "set null" }),
    outOfWindow: boolean("out_of_window").notNull().default(false),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("return_requests_tenant_number_uq").on(t.tenantId, t.number),
    index("return_requests_order_idx").on(t.orderId),
    index("return_requests_tenant_status_idx").on(t.tenantId, t.status, t.requestedAt),
    tenantIsolation("return_requests"),
  ],
).enableRLS();

export const returnLines = pgTable(
  "return_lines",
  {
    ...tenantColumns(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => returnRequests.id, { onDelete: "cascade" }),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    inspectionOutcome: text("inspection_outcome"),
    inspectionAmountMinor: integer("inspection_amount_minor"),
    restocked: boolean("restocked").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("return_lines_return_idx").on(t.returnId), tenantIsolation("return_lines")],
).enableRLS();
