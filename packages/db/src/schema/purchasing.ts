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
    /** Variability of the lead time (days, one standard deviation) for safety stock. */
    leadTimeSdDays: integer("lead_time_sd_days"),
    /** Payment terms: deposit share at order (basis points) and balance days after receipt. */
    depositBps: integer("deposit_bps").notNull().default(0),
    balanceDays: integer("balance_days").notNull().default(30),
    moqDefault: integer("moq_default"),
    orderMultipleDefault: integer("order_multiple_default"),
    contactName: text("contact_name"),
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
    /** manual | auto (generated from the replenishment plan) */
    source: text("source").notNull().default("manual"),
    /** Unguessable token for the supplier confirmation page; null until sent. */
    supplierToken: text("supplier_token"),
    supplierAckAt: timestamp("supplier_ack_at", { withTimezone: true }),
    supplierAckNote: text("supplier_ack_note"),
    sentToEmail: text("sent_to_email"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("purchase_orders_tenant_number_uq").on(t.tenantId, t.number), index("purchase_orders_status_idx").on(t.tenantId, t.status), uniqueIndex("purchase_orders_supplier_token_uq").on(t.supplierToken), tenantIsolation("purchase_orders")],
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
    /** Unit cost including allocated duties, freight and fees; feeds product cost on receipt when set. */
    landedUnitCostMinor: integer("landed_unit_cost_minor"),
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


/** Supplier conditions per variant: the supplier's SKU and price, MOQ, order multiple, lead time override. */
export const supplierVariants = pgTable(
  "supplier_variants",
  {
    ...tenantColumns(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    supplierSku: text("supplier_sku"),
    unitCostMinor: integer("unit_cost_minor"),
    moq: integer("moq"),
    orderMultiple: integer("order_multiple"),
    leadTimeDays: integer("lead_time_days"),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("supplier_variants_uq").on(t.tenantId, t.supplierId, t.variantId), index("supplier_variants_variant_idx").on(t.tenantId, t.variantId), tenantIsolation("supplier_variants")],
).enableRLS();

/** Duties, freight and fees of a purchase order, allocated to its lines as landed cost. */
export const purchaseOrderCharges = pgTable(
  "purchase_order_charges",
  {
    ...tenantColumns(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    /** duty | freight | fee | other */
    kind: text("kind").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    /** value | quantity | weight */
    basis: text("basis").notNull().default("value"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("purchase_order_charges_po_idx").on(t.tenantId, t.purchaseOrderId), tenantIsolation("purchase_order_charges")],
).enableRLS();

/** Demand events with an uplift (Black Friday, a promotion), for all products or a product type. */
export const demandEvents = pgTable(
  "demand_events",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    /** YYYY-MM */
    month: text("month").notNull(),
    upliftBps: integer("uplift_bps").notNull(),
    /** all | product_type | product */
    scope: text("scope").notNull().default("all"),
    scopeValue: text("scope_value"),
    createdAt: createdAt(),
  },
  (t) => [index("demand_events_tenant_month_idx").on(t.tenantId, t.month), tenantIsolation("demand_events")],
).enableRLS();

/** Manual correction of the forecast for one variant and month. */
export const forecastOverrides = pgTable(
  "forecast_overrides",
  {
    ...tenantColumns(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    units: integer("units").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("forecast_overrides_uq").on(t.tenantId, t.variantId, t.month), tenantIsolation("forecast_overrides")],
).enableRLS();

/** Components of a bundle (sold as one, stock derived) or of a manufactured item (bill of materials). */
export const bundleComponents = pgTable(
  "bundle_components",
  {
    ...tenantColumns(),
    parentVariantId: uuid("parent_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    componentVariantId: uuid("component_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    /** bundle | bom */
    kind: text("kind").notNull().default("bundle"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bundle_components_uq").on(t.tenantId, t.parentVariantId, t.componentVariantId), index("bundle_components_component_idx").on(t.tenantId, t.componentVariantId), tenantIsolation("bundle_components")],
).enableRLS();
