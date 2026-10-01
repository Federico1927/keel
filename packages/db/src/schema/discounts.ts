import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

export const discountPools = pgTable(
  "discount_pools",
  {
    ...tenantColumns(),
    title: text("title").notNull(),
    prefix: text("prefix").notNull(),
    type: text("type").notNull().default("percentage"),
    value: integer("value").notNull(),
    targetSize: integer("target_size").notNull(),
    status: text("status").notNull().default("ready"),
    externalId: text("external_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("discount_pools_tenant_idx").on(t.tenantId), tenantIsolation("discount_pools")],
).enableRLS();

export const discounts = pgTable(
  "discounts",
  {
    ...tenantColumns(),
    externalId: text("external_id"),
    poolId: uuid("pool_id").references(() => discountPools.id, { onDelete: "set null" }),
    code: text("code").notNull(),
    title: text("title"),
    /** percentage | fixed_amount | free_shipping */
    type: text("type").notNull().default("percentage"),
    /** Percentage in basis points or amount in minor units. */
    value: integer("value").notNull().default(0),
    minimumAmountMinor: integer("minimum_amount_minor"),
    usageLimit: integer("usage_limit"),
    usedCount: integer("used_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    /** platform | keel */
    source: text("source").notNull().default("platform"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("discounts_tenant_code_uq").on(t.tenantId, t.code), index("discounts_pool_idx").on(t.poolId), tenantIsolation("discounts")],
).enableRLS();
