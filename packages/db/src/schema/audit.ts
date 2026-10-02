import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, hullwiseApp, tenantPredicate } from "./_common";
import { pgPolicy } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { tenants } from "./tenants";

/**
 * Platform-wide audit log. Rows can belong to a tenant (tenant actions, super-admin
 * actions on a tenant) or be global (tenant_id null: platform billing, tenant creation).
 * Written only through the admin connection or the audit service; readable by tenant
 * owners through RLS for their own tenant.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** `user` | `system` | `super_admin` | `impersonation` | `mcp` */
    actorType: text("actor_type").notNull().default("user"),
    impersonatedBy: uuid("impersonated_by").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    // Tenant users read and append only their tenant's rows; never update or delete.
    pgPolicy("audit_logs_tenant_select", { for: "select", to: hullwiseApp, using: tenantPredicate }),
    pgPolicy("audit_logs_tenant_insert", { for: "insert", to: hullwiseApp, withCheck: tenantPredicate }),
  ],
).enableRLS();
