import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tenantIsolation, updatedAt } from "./_common";
import { users } from "./auth";

/**
 * Tenants are platform-level rows (no RLS): the application reads them to
 * resolve the slug, the plan and the active add-ons before any tenant query.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "suspended", "trial", "churned"] })
      .notNull()
      .default("active"),
    planKey: text("plan_key").notNull().default("starter"),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    timezone: text("timezone").notNull(),
    defaultLocale: text("default_locale").notNull().default("en"),
    orderNumberPrefix: text("order_number_prefix").notNull().default(""),
    /** Typed settings blob; keys documented in @keel/core tenant-settings. */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    suspendAfterDays: integer("suspend_after_days").notNull().default(14),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** MCP kill switch (#21): set by a super-admin, every MCP call of the tenant is refused until cleared. */
    mcpDisabledAt: timestamp("mcp_disabled_at", { withTimezone: true }),
    mcpDisabledNote: text("mcp_disabled_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tenants_status_idx").on(t.status)],
);

export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "operations", "customer_care", "marketing", "viewer"] }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tenant_memberships_tenant_user_uq").on(t.tenantId, t.userId),
    index("tenant_memberships_user_idx").on(t.userId),
    // Read by the auth layer through the admin connection; the app role only sees its own tenant.
    tenantIsolation("tenant_memberships"),
  ],
).enableRLS();

/**
 * Invitations to join a tenant (#52). The token is stored as its SHA-256 only, expires (7 days) and
 * works once. `status` is pending | accepted | revoked; a pending row past `expires_at` is expired.
 * Tenant data under RLS for the Users page; the accept page reads it by token hash through the
 * admin connection (the auth layer, like tenant_memberships).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "operations", "customer_care", "marketing", "viewer"] }).notNull(),
    /** Name suggested by the inviter, pre-filled on the accept page. */
    name: text("name"),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "accepted", "revoked"] })
      .notNull()
      .default("pending"),
    sendCount: integer("send_count").notNull().default(1),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: uuid("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("invitations_tenant_status_idx").on(t.tenantId, t.status), index("invitations_tenant_email_idx").on(t.tenantId, t.email), tenantIsolation("invitations")],
).enableRLS();

/** Add-ons activated per tenant by the super-admin. */
export const tenantAddons = pgTable(
  "tenant_addons",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    moduleKey: text("module_key").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    note: text("note"),
    activatedBy: uuid("activated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tenant_addons_tenant_module_uq").on(t.tenantId, t.moduleKey), tenantIsolation("tenant_addons")],
).enableRLS();

/** Tax rates per country, per tenant (CLAUDE.md §3). Platform-level table with tenant column but
 * read before the tenant context exists only via admin; still isolated by RLS. */
export const tenantTaxRates = pgTable(
  "tenant_tax_rates",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    country: text("country").notNull(),
    /** Basis points, e.g. 2200 = 22%. */
    rateBps: integer("rate_bps").notNull(),
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tenant_tax_rates_uq").on(t.tenantId, t.country), tenantIsolation("tenant_tax_rates")],
).enableRLS();

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * Tenant branding (#44): brand colour and logos. The default for every tenant-branded page (app
 * primary colour, return portal, tracking page, supplier page, survey); those pages may still
 * override it in their own settings.
 */
export const tenantBranding = pgTable(
  "tenant_branding",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `#rrggbb` as chosen; the AA-safe light/dark variants are derived at render time. */
    brandColor: text("brand_color"),
    logoLightData: bytea("logo_light_data"),
    logoLightType: text("logo_light_type"),
    logoDarkData: bytea("logo_dark_data"),
    logoDarkType: text("logo_dark_type"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tenant_branding_tenant_uq").on(t.tenantId), tenantIsolation("tenant_branding")],
).enableRLS();
