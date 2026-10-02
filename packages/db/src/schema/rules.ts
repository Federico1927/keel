import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";

/** Per-tenant mapping rules (CLAUDE.md §4). Shape validated by @hullwise/core stateRuleSchema. */
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

/**
 * Costs entered per month for the P/L: fixed lines (rent, payroll, tools, agencies) and the
 * shipping invoice, each with an estimate and the actual once known. `cost_settings` stays as
 * the legacy flat monthly amount and the per-order shipping estimate.
 */
export const periodCosts = pgTable(
  "period_costs",
  {
    ...tenantColumns(),
    /** YYYY-MM */
    period: text("period").notNull(),
    /** fixed | shipping | other */
    kind: text("kind").notNull(),
    label: text("label").notNull().default(""),
    estimateMinor: integer("estimate_minor").notNull().default(0),
    actualMinor: integer("actual_minor"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("period_costs_uq").on(t.tenantId, t.period, t.kind, t.label), index("period_costs_tenant_period_idx").on(t.tenantId, t.period), tenantIsolation("period_costs")],
).enableRLS();
