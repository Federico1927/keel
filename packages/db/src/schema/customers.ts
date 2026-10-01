import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

export const customers = pgTable(
  "customers",
  {
    ...tenantColumns(),
    externalId: text("external_id"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    country: text("country"),
    city: text("city"),
    zip: text("zip"),
    acceptsMarketing: boolean("accepts_marketing").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ordersCount: integer("orders_count").notNull().default(0),
    totalSpentMinor: integer("total_spent_minor").notNull().default(0),
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    platformCreatedAt: timestamp("platform_created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customers_tenant_external_uq").on(t.tenantId, t.externalId),
    index("customers_email_idx").on(t.tenantId, t.emailNormalized),
    index("customers_phone_idx").on(t.tenantId, t.phoneE164),
    index("customers_last_order_idx").on(t.tenantId, t.lastOrderAt),
    tenantIsolation("customers"),
  ],
).enableRLS();
