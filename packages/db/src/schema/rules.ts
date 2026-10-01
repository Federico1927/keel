import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

/** Per-tenant mapping rules (CLAUDE.md §4). Shape validated by @keel/core stateRuleSchema. */
export const stateRules = pgTable(
  "state_rules",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    conditions: jsonb("conditions").notNull().default(sql`'{}'::jsonb`),
    resultStatus: text("result_status").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("state_rules_tenant_priority_idx").on(t.tenantId, t.priority), tenantIsolation("state_rules")],
).enableRLS();

/** Cost settings used by P/L: shipping per order, fixed monthly costs, with validity windows. */
export const costSettings = pgTable(
  "cost_settings",
  {
    ...tenantColumns(),
    /** shipping_per_order | fixed_monthly */
    kind: text("kind").notNull(),
    label: text("label"),
    amountMinor: integer("amount_minor").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    createdAt: createdAt(),
  },
  (t) => [index("cost_settings_tenant_kind_idx").on(t.tenantId, t.kind, t.validFrom), tenantIsolation("cost_settings")],
).enableRLS();
