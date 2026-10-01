import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { customers } from "./customers";
import { productVariants, products } from "./catalog";

export const orders = pgTable(
  "orders",
  {
    ...tenantColumns(),
    externalId: text("external_id"),
    /** Numeric part, e.g. 1001. */
    orderNumber: integer("order_number").notNull(),
    /** Display name as the platform shows it, e.g. "#NW-1001". */
    name: text("name").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    /** Canonical status (CLAUDE.md §4). Written only by the order state service. */
    status: text("status").notNull().default("new"),
    /** rules | manual */
    statusSource: text("status_source").notNull().default("rules"),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    manualStatus: text("manual_status"),
    paymentMethod: text("payment_method").notNull().default("other"),
    paymentStatus: text("payment_status").notNull().default("pending"),
    paymentGateways: text("payment_gateways").array().notNull().default(sql`'{}'::text[]`),
    financialStatusRaw: text("financial_status_raw"),
    fulfillmentStatusRaw: text("fulfillment_status_raw"),
    platformTags: text("platform_tags").array().notNull().default(sql`'{}'::text[]`),
    currency: text("currency").notNull(),
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    discountMinor: integer("discount_minor").notNull().default(0),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull().default(0),
    refundedMinor: integer("refunded_minor").notNull().default(0),
    /** Fraction of lines returned, maintained by the returns module. */
    returnedFraction: integer("returned_fraction_bps").notNull().default(0),
    shippingAddress: jsonb("shipping_address"),
    billingAddress: jsonb("billing_address"),
    shippingCountry: text("shipping_country"),
    shippingZip: text("shipping_zip"),
    shippingCity: text("shipping_city"),
    addressKey: text("address_key"),
    nameZipKey: text("name_zip_key"),
    note: text("note"),
    noteAttributes: jsonb("note_attributes").notNull().default(sql`'[]'::jsonb`),
    landingSite: text("landing_site"),
    referringSite: text("referring_site"),
    /** web | pos | draft | manual | api */
    sourceChannel: text("source_channel").notNull().default("web"),
    isTest: boolean("is_test").notNull().default(false),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    holdReason: text("hold_reason"),
    /** Lineage of cancel-and-recreate edits: the order this one replaces, the one that replaced it, and the first order of the chain. */
    replacesOrderId: uuid("replaces_order_id"),
    replacedByOrderId: uuid("replaced_by_order_id"),
    lineageRootOrderId: uuid("lineage_root_order_id"),
    platformUpdatedAt: timestamp("platform_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    searchBlob: text("search_blob")
      .generatedAlwaysAs(sql`lower(coalesce(name, '') || ' ' || coalesce(customer_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, ''))`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_tenant_external_uq").on(t.tenantId, t.externalId),
    uniqueIndex("orders_tenant_number_uq").on(t.tenantId, t.orderNumber),
    index("orders_tenant_placed_idx").on(t.tenantId, t.placedAt),
    index("orders_tenant_status_idx").on(t.tenantId, t.status),
    index("orders_tenant_customer_idx").on(t.tenantId, t.customerId),
    index("orders_tenant_email_idx").on(t.tenantId, t.emailNormalized),
    index("orders_tenant_phone_idx").on(t.tenantId, t.phoneE164),
    index("orders_tenant_address_idx").on(t.tenantId, t.addressKey),
    index("orders_search_trgm_idx").using("gin", sql`${t.searchBlob} gin_trgm_ops`),
    tenantIsolation("orders"),
  ],
).enableRLS();

export const orderLines = pgTable(
  "order_lines",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    sku: text("sku"),
    title: text("title").notNull(),
    variantTitle: text("variant_title"),
    quantity: integer("quantity").notNull(),
    currentQuantity: integer("current_quantity").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    discountMinor: integer("discount_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    /** Cost snapshot at import time (last purchase cost), minor units. */
    unitCostMinor: integer("unit_cost_minor"),
    isAncillary: boolean("is_ancillary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("order_lines_tenant_external_uq").on(t.tenantId, t.externalId),
    index("order_lines_order_idx").on(t.orderId),
    index("order_lines_variant_idx").on(t.tenantId, t.variantId),
    tenantIsolation("order_lines"),
  ],
).enableRLS();

export const orderEvents = pgTable(
  "order_events",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** user | system | integration */
    actorType: text("actor_type").notNull().default("system"),
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.createdAt), tenantIsolation("order_events")],
).enableRLS();

export const orderNotes = pgTable(
  "order_notes",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    mentions: uuid("mentions").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("order_notes_order_idx").on(t.orderId, t.createdAt), tenantIsolation("order_notes")],
).enableRLS();

export const orderDiscounts = pgTable(
  "order_discounts",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    type: text("type").notNull().default("percentage"),
    amountMinor: integer("amount_minor").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("order_discounts_code_idx").on(t.tenantId, t.code), index("order_discounts_order_idx").on(t.orderId), tenantIsolation("order_discounts")],
).enableRLS();

export const orderAttribution = pgTable(
  "order_attribution",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    clickIds: jsonb("click_ids").notNull().default(sql`'{}'::jsonb`),
    campaignId: uuid("campaign_id"),
    channel: text("channel").notNull().default("unknown"),
    /** webhook | sync | backfill | seed */
    source: text("source").notNull().default("sync"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("order_attribution_order_uq").on(t.orderId), index("order_attribution_campaign_idx").on(t.tenantId, t.campaignId), tenantIsolation("order_attribution")],
).enableRLS();
