"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb, eq, recordAudit, schema } from "@keel/db";
import { dashboardPeriod, previousPeriod, tenantSettingsSchema } from "@keel/core";
import { DASHBOARD_PERIODS, TENANT_ROLES, canEditDashboard, canSeeDashboard } from "@keel/config";
import { DashboardError, MetricDefinitionError, createDashboard, customiseHome, dashboardView, deleteDashboard, deleteTenantMetric, discardDashboardDraft, duplicateToPersonal, getDashboard, publishDashboard, resetHomeToTemplate, resolveHomeDashboard, saveDashboard, saveTenantMetric, setMetricTarget, tenantHomeView, tenantMetricValues, validateTenantMetric, type CustomMetricRow, type ServiceContext } from "@keel/services";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requireAction, requirePage, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { analyticsTenant, sharedMemo } from "@/server/dashboards";
import { formatMetric } from "@/components/dashboard/format";

const svc = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });

function handle(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof DashboardError) return fail(e.code);
  if (e instanceof MetricDefinitionError) return fail(e.message === "invalid_filters" || e.message === "invalid_key" || e.message === "not_filterable" ? e.message : "invalid_formula", { detail: e.message });
  throw e;
}

const refresh = (slug: string) => {
  revalidatePath(`/t/${slug}`);
  revalidatePath(`/t/${slug}/dashboards`, "layout");
};

const rolesSchema = z.array(z.enum(TENANT_ROLES)).max(TENANT_ROLES.length);

/** A dashboard the acting user may change (tenant and role ones need `manage_dashboard`, personal ones their owner). */
async function editable(slug: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new DashboardError("not_found");
  const ctx = await requirePage(slug, "dashboard");
  const row = await ctx.run((tx) => getDashboard(svc(ctx, tx), id));
  if (!row) throw new DashboardError("not_found");
  if (!canEditDashboard(ctx.role, ctx.user.id, row, ctx.settings.personalDashboards)) throw new ForbiddenError("manage_dashboard");
  return { ctx, row };
}

/* ---------- dashboards ---------- */

export async function customiseHomeAction(slug: string, name: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireAction(slug, "manage_dashboard");
    const row = await ctx.run((tx) => customiseHome(svc(ctx, tx), { activeAddons: ctx.activeAddons, name: name.trim().slice(0, 80) || "Home", audit: auditActor(ctx) }));
    refresh(slug);
    return ok({ id: row.id });
  } catch (e) {
    return handle(e);
  }
}

const createSchema = z.object({ name: z.string().trim().min(1).max(80), scope: z.enum(["tenant", "role", "personal"]), roles: rolesSchema.default([]), fromId: z.string().uuid().nullable().default(null) });

/** New extra dashboard (empty or copied), a home variant for roles (copy of the current home), or a personal copy. */
export async function createDashboardAction(slug: string, input: z.input<typeof createSchema>): Promise<ActionResult<{ id: string }>> {
  try {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const { name, scope, roles, fromId } = parsed.data;
    const ctx = scope === "personal" ? await requirePage(slug, "dashboard") : await requireAction(slug, "manage_dashboard");
    if (scope === "personal" && !ctx.settings.personalDashboards) return fail("personal_off");
    const row = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      const source = fromId ? await getDashboard(s, fromId) : null;
      if (fromId && (!source || !canSeeDashboard(ctx.role, ctx.user.id, source, ctx.settings.personalDashboards))) throw new DashboardError("not_found");
      // a personal copy starts from the dashboard named or the user's home; a role variant from the tenant home
      const base = source ? dashboardView(source) : scope === "personal" ? await resolveHomeDashboard(s, ctx.role, ctx.activeAddons) : scope === "role" ? await tenantHomeView(s, ctx.activeAddons) : null;
      if (scope === "personal") return duplicateToPersonal(s, base!, { name, activeAddons: ctx.activeAddons, audit: auditActor(ctx) });
      return createDashboard(s, { name, scope, roles, isHome: scope === "role", widgets: base?.widgets ?? [], settings: base?.settings }, { activeAddons: ctx.activeAddons, audit: auditActor(ctx) });
    });
    refresh(slug);
    return ok({ id: row.id });
  } catch (e) {
    return handle(e);
  }
}

const saveSchema = z.object({ widgets: z.array(z.unknown()).max(60), name: z.string().trim().min(1).max(80).optional(), roles: rolesSchema.optional(), period: z.enum(DASHBOARD_PERIODS).optional(), publish: z.boolean().default(false) });

/** Saves the editor: as the draft, or published at once. */
export async function saveDashboardLayoutAction(slug: string, id: string, input: z.input<typeof saveSchema>): Promise<ActionResult> {
  try {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const { ctx, row } = await editable(slug, id);
    const { widgets, name, roles, period, publish } = parsed.data;
    await ctx.run((tx) => saveDashboard(svc(ctx, tx), row.id, { widgets, name, roles: row.scope === "personal" ? undefined : roles, settings: period ? { period } : undefined, publish }, { activeAddons: ctx.activeAddons, audit: auditActor(ctx) }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function publishDashboardAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const { ctx, row } = await editable(slug, id);
    await ctx.run((tx) => publishDashboard(svc(ctx, tx), row.id, { activeAddons: ctx.activeAddons, audit: auditActor(ctx) }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function discardDashboardDraftAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const { ctx, row } = await editable(slug, id);
    await ctx.run((tx) => discardDashboardDraft(svc(ctx, tx), row.id, { audit: auditActor(ctx) }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function deleteDashboardAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const { ctx, row } = await editable(slug, id);
    await ctx.run((tx) => deleteDashboard(svc(ctx, tx), row.id, { audit: auditActor(ctx) }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/**
 * Back to Keel's template: `tenant` resets the tenant home, `all` also the role variants. Reached by
 * owners and admins, and by a super-admin through impersonation (audited as impersonation) for support.
 */
export async function resetHomeAction(slug: string, scope: "tenant" | "all"): Promise<ActionResult<{ removed: number }>> {
  try {
    const ctx = await requireAction(slug, "manage_dashboard");
    const removed = await ctx.run((tx) => resetHomeToTemplate(svc(ctx, tx), scope === "all" ? "all" : "tenant", { audit: auditActor(ctx) }));
    refresh(slug);
    return ok({ removed });
  } catch (e) {
    return handle(e);
  }
}

/** Personal dashboards on or off for the tenant (tenant settings, written through the admin connection and audited). */
export async function setPersonalDashboardsAction(slug: string, enabled: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_dashboard");
    const next = tenantSettingsSchema.parse({ ...ctx.settings, personalDashboards: Boolean(enabled) });
    await adminDb().update(schema.tenants).set({ settings: next }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.dashboards_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: { personalDashboards: { from: ctx.settings.personalDashboards, to: next.personalDashboards } } }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/* ---------- metrics and targets ---------- */

const metricSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  formula: z.string().trim().min(1).max(300),
  format: z.enum(["money", "ratio", "percent", "number"]),
  description: z.string().trim().max(300).nullable().optional(),
  filters: z.record(z.string(), z.unknown()).default({}),
  higherIsBetter: z.boolean().default(true),
  translations: z.record(z.string().max(10), z.string().max(80)).default({}),
});

export async function saveTenantMetricAction(slug: string, input: z.input<typeof metricSchema>): Promise<ActionResult<{ key: string }>> {
  try {
    const parsed = metricSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const ctx = await requireAction(slug, "manage_dashboard");
    const row = await ctx.run((tx) => saveTenantMetric(svc(ctx, tx), parsed.data, { audit: auditActor(ctx) }));
    refresh(slug);
    return ok({ key: row.key });
  } catch (e) {
    return handle(e);
  }
}

export async function deleteTenantMetricAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_dashboard");
    if (!z.string().uuid().safeParse(id).success) return fail("invalid_input");
    await ctx.run((tx) => deleteTenantMetric(svc(ctx, tx), id, { audit: auditActor(ctx) }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Value of a metric being edited on the current month (and the previous period), without saving it. */
export async function previewMetricAction(slug: string, input: z.input<typeof metricSchema>): Promise<ActionResult<{ value: string; previous: string; period: string }>> {
  try {
    const parsed = metricSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const ctx = await requireAction(slug, "manage_dashboard");
    const { key, filters } = validateTenantMetric(parsed.data);
    const draft = { key, label: parsed.data.label, formula: parsed.data.formula, format: parsed.data.format, filters: filters ?? {}, higherIsBetter: parsed.data.higherIsBetter, translations: {} } as unknown as CustomMetricRow;
    const period = dashboardPeriod("mtd", new Date(), ctx.tenant.timezone);
    const [v] = await ctx.run((tx) => tenantMetricValues(svc(ctx, tx), analyticsTenant(ctx), period, previousPeriod(period), [`custom:${key}`], { customs: [draft], memo: sharedMemo }));
    const f = (x: number | null | undefined) => formatMetric(x, parsed.data.format, ctx.tenant.currency, ctx.locale);
    return ok({ value: f(v?.value), previous: f(v?.previous), period: "mtd" });
  } catch (e) {
    return handle(e);
  }
}

const targetSchema = z.object({ metric: z.string().trim().min(1).max(60), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), target: z.number().finite().nullable() });

export async function setMetricTargetAction(slug: string, input: z.input<typeof targetSchema>): Promise<ActionResult> {
  try {
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const ctx = await requireAction(slug, "manage_dashboard");
    await ctx.run((tx) => setMetricTarget(svc(ctx, tx), parsed.data, { audit: auditActor(ctx) }));
    refresh(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}
