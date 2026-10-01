import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

export const locations = pgTable(
  "locations",
  {
    ...tenantColumns(),
    externalId: text("external_id"),
    name: text("name").notNull(),
    country: text("country"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("locations_tenant_external_uq").on(t.tenantId, t.externalId), tenantIsolation("locations")],
).enableRLS();

export const products = pgTable(
  "products",
  {
    ...tenantColumns(),
    externalId: text("external_id"),
    title: text("title").notNull(),
    handle: text("handle"),
    vendor: text("vendor"),
    productType: text("product_type"),
    status: text("status").notNull().default("active"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Dynamic options: [{ name: "Size", values: ["S","M"] }] — never hardcoded size/colour. */
    options: jsonb("options").notNull().default(sql`'[]'::jsonb`),
    imageUrl: text("image_url"),
    isAncillary: boolean("is_ancillary").notNull().default(false),
    isRepurchasable: boolean("is_repurchasable").notNull().default(true),
    platformCreatedAt: timestamp("platform_created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_tenant_external_uq").on(t.tenantId, t.externalId),
    index("products_tenant_title_idx").on(t.tenantId, t.title),
    tenantIsolation("products"),
  ],
).enableRLS();

export const productVariants = pgTable(
  "product_variants",
  {
    ...tenantColumns(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    inventoryItemExternalId: text("inventory_item_external_id"),
    sku: text("sku"),
    barcode: text("barcode"),
    title: text("title").notNull(),
    /** { "Size": "M", "Color": "Navy" } */
    optionValues: jsonb("option_values").notNull().default(sql`'{}'::jsonb`),
    priceMinor: integer("price_minor").notNull().default(0),
    compareAtMinor: integer("compare_at_minor"),
    /** Latest unit cost; snapshotted on order lines and feeds the P/L. */
    costMinor: integer("cost_minor"),
    /** Where `cost_minor` came from: platform | manual | import | po_receipt (null: written before this column). */
    costSource: text("cost_source"),
    costUpdatedAt: timestamp("cost_updated_at", { withTimezone: true }),
    averageCostMinor: integer("average_cost_minor"),
    weightGrams: integer("weight_grams"),
    packSize: integer("pack_size"),
    isActive: boolean("is_active").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("product_variants_tenant_external_uq").on(t.tenantId, t.externalId),
    index("product_variants_product_idx").on(t.productId),
    index("product_variants_sku_idx").on(t.tenantId, t.sku),
    tenantIsolation("product_variants"),
  ],
).enableRLS();

export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    ...tenantColumns(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    available: integer("available").notNull().default(0),
    committed: integer("committed").notNull().default(0),
    onHand: integer("on_hand").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("inventory_levels_variant_location_uq").on(t.variantId, t.locationId), index("inventory_levels_tenant_idx").on(t.tenantId), tenantIsolation("inventory_levels")],
).enableRLS();

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    ...tenantColumns(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    /** receipt | return_restock | adjustment | sync | sale */
    reason: text("reason").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("inventory_movements_variant_idx").on(t.tenantId, t.variantId, t.createdAt), tenantIsolation("inventory_movements")],
).enableRLS();
