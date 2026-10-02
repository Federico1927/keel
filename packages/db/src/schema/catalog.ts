import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
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
    /** Cover image (the first media); `product_media` holds the whole gallery. */
    imageUrl: text("image_url"),
    // Read mirror of the platform product (issue #19): refreshed by sync and webhooks; null = never read.
    descriptionHtml: text("description_html"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    /** Platform taxonomy category (Shopify Standard Product Taxonomy id and full name). */
    categoryId: text("category_id"),
    categoryName: text("category_name"),
    /** [{ id, title, handle }]: collections the product belongs to (read-only). */
    collections: jsonb("collections"),
    /** [{ id, name, published, publishedAt }]: sales channels / publications (read-only). */
    publishedChannels: jsonb("published_channels"),
    /** [{ namespace, key, type, value }]: first metafields, read-only (definitions are out of scope). */
    metafields: jsonb("metafields"),
    /** The platform's `updatedAt` of the version Keel holds: an edit opened on an older version is refused. */
    platformUpdatedAt: timestamp("platform_updated_at", { withTimezone: true }),
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
    index("products_title_trgm_idx").using("gin", sql`lower(${t.title}) gin_trgm_ops`),
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
    // Platform mirror (issue #19); null = not read yet.
    imageMediaId: uuid("image_media_id").references((): AnyPgColumn => productMedia.id, { onDelete: "set null" }),
    /** deny | continue: selling when out of stock. */
    inventoryPolicy: text("inventory_policy"),
    tracksInventory: boolean("tracks_inventory"),
    requiresShipping: boolean("requires_shipping"),
    taxable: boolean("taxable"),
    hsCode: text("hs_code"),
    countryOfOrigin: text("country_of_origin"),
    isActive: boolean("is_active").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("product_variants_tenant_external_uq").on(t.tenantId, t.externalId),
    index("product_variants_product_idx").on(t.productId),
    index("product_variants_sku_idx").on(t.tenantId, t.sku),
    index("product_variants_sku_trgm_idx").using("gin", sql`lower(${t.sku}) gin_trgm_ops`),
    tenantIsolation("product_variants"),
  ],
).enableRLS();

/**
 * Product gallery mirrored from the platform (issue #19): images, videos and 3D models in display
 * order. `url` is always an image (the preview for videos and models). `external_id` is the
 * platform's media gid (its type is part of it); null for media of a product Keel holds alone.
 */
export const productMedia = pgTable(
  "product_media",
  {
    ...tenantColumns(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    /** image | video | model */
    type: text("type").notNull().default("image"),
    url: text("url").notNull(),
    alt: text("alt"),
    position: integer("position").notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("product_media_product_external_uq").on(t.productId, t.externalId), index("product_media_tenant_product_idx").on(t.tenantId, t.productId, t.position), tenantIsolation("product_media")],
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
    /** receipt | return_restock | adjustment | transfer_in | transfer_out | sync | sale */
    reason: text("reason").notNull(),
    /** For `adjustment`: damaged | lost | found | count_correction | other (issue #30). */
    reasonCode: text("reason_code"),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("inventory_movements_variant_idx").on(t.tenantId, t.variantId, t.createdAt), tenantIsolation("inventory_movements")],
).enableRLS();

/**
 * Stock drift: a platform read changed stock in a way Keel did not expect (no sale, return,
 * receipt or adjustment explains it), a negative level was clamped, or a level was no longer
 * reported. Deduplicated on `dedupe_key`: the same discrepancy seen again bumps `occurrences`.
 */
export const inventoryDrift = pgTable(
  "inventory_drift",
  {
    ...tenantColumns(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    /** unexplained | negative | not_reported */
    kind: text("kind").notNull(),
    /** sync | reconcile | webhook | manual */
    source: text("source").notNull(),
    runId: uuid("run_id"),
    localBefore: integer("local_before").notNull(),
    expected: integer("expected").notNull(),
    observed: integer("observed").notNull(),
    /** Unexplained units (observed − expected). */
    delta: integer("delta").notNull(),
    applied: integer("applied").notNull(),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    dedupeKey: text("dedupe_key").notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inventory_drift_dedupe_uq").on(t.tenantId, t.dedupeKey), index("inventory_drift_tenant_seen_idx").on(t.tenantId, t.lastSeenAt), tenantIsolation("inventory_drift")],
).enableRLS();
