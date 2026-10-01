import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { locations, productVariants } from "./catalog";
import { users } from "./auth";

export const suppliers = pgTable(
  "suppliers",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    payeeName: text("payee_name"),
    email: text("email"),
    phone: text("phone"),
    country: text("country"),
    currency: text("currency"),
    leadTimeDays: integer("lead_time_days"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("suppliers_tenant_idx").on(t.tenantId, t.name), tenantIsolation("suppliers")],
).enableRLS();

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    ...tenantColumns(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    number: text("number").notNull(),
    status: text("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    destinationLocationId: uuid("destination_location_id").references(() => locations.id, { onDelete: "set null" }),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    expectedAt: timestamp("expected_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    totalMinor: integer("total_minor").notNull().default(0),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("purchase_orders_tenant_number_uq").on(t.tenantId, t.number), index("purchase_orders_status_idx").on(t.tenantId, t.status), tenantIsolation("purchase_orders")],
).enableRLS();

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    ...tenantColumns(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    description: text("description"),
    quantity: integer("quantity").notNull(),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    unitCostMinor: integer("unit_cost_minor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("purchase_order_lines_po_idx").on(t.purchaseOrderId), index("purchase_order_lines_variant_idx").on(t.tenantId, t.variantId), tenantIsolation("purchase_order_lines")],
).enableRLS();

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    ...tenantColumns(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    amountMinor: integer("amount_minor").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    method: text("method"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("supplier_payments_supplier_idx").on(t.tenantId, t.supplierId), tenantIsolation("supplier_payments")],
).enableRLS();

/** Order lines waiting for stock, linked to the purchase order line that will cover them. */
export const backorders = pgTable(
  "backorders",
  {
    ...tenantColumns(),
    orderLineId: uuid("order_line_id").notNull(),
    orderId: uuid("order_id").notNull(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").references(() => purchaseOrderLines.id, { onDelete: "set null" }),
    /** pending | covered | fulfilled | cancelled */
    status: text("status").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("backorders_variant_idx").on(t.tenantId, t.variantId, t.status), tenantIsolation("backorders")],
).enableRLS();
