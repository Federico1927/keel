"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appUrl, canWritePage } from "@hullwise/config";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { encryptJson } from "@hullwise/integrations";
import { MetricError, deleteAlertRule, deleteCustomMetric, evaluateAlertRules, saveAlertRule, saveCustomMetric, saveUserDashboard } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requirePage, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const svc = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
const at = (ctx: TenantContext) => ({ id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings });

async function requireAnalyticsWrite(slug: string) {
  const ctx = await requirePage(slug, "analytics");
  if (!canWritePage(ctx.role, "analytics")) throw new ForbiddenError("edit");
  return ctx;
}
const handle = (e: unknown): ActionResult => {
  if (e instanceof ForbiddenError) return fail("forbidden");
  if (e instanceof MetricError) return fail("invalid_formula", { detail: e.message });
  throw e;
};

/* ---------- custom metrics ---------- */

export async function saveCustomMetricAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    const parsed = z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), formula: z.string().min(1).max(300), format: z.enum(["money", "ratio", "percent", "number"]) }).safeParse({ key: formData.get("key") || formData.get("label"), label: formData.get("label"), formula: formData.get("formula"), format: formData.get("format") });
    if (!parsed.success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const row = await saveCustomMetric(svc(ctx, tx), parsed.data);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "custom_metric.saved", entityType: "custom_metric", entityId: row.id, diff: { formula: { from: null, to: row.formula } } });
    });
    revalidatePath(`/t/${slug}/analytics`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function deleteCustomMetricAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    if (!z.string().uuid().safeParse(id).success) return fail("invalid_input");
    await ctx.run(async (tx) => {
      await deleteCustomMetric(svc(ctx, tx), id);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "custom_metric.deleted", entityType: "custom_metric", entityId: id });
    });
    revalidatePath(`/t/${slug}/analytics`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Every analytics reader may arrange their own dashboard. */
export async function saveDashboardAction(slug: string, metrics: string[]): Promise<ActionResult> {
  try {
    const ctx = await requirePage(slug, "analytics");
    const parsed = z.array(z.string().max(60)).max(24).safeParse(metrics);
    if (!parsed.success) return fail("invalid_input");
    await ctx.run((tx) => saveUserDashboard(svc(ctx, tx), ctx.user.id, parsed.data.map((m) => ({ metric: m }))));
    revalidatePath(`/t/${slug}/analytics`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/* ---------- alerts ---------- */

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("threshold"), op: z.enum(["lt", "gt"]), value: z.coerce.number(), days: z.coerce.number().int().min(1).max(14) }),
  z.object({ kind: z.literal("anomaly"), direction: z.enum(["up", "down", "both"]), sensitivity: z.coerce.number().min(1).max(6), baselineDays: z.coerce.number().int().min(7).max(90) }),
]);

export async function saveAlertRuleAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    const kind = formData.get("kind");
    const condition = conditionSchema.safeParse(kind === "threshold" ? { kind, op: formData.get("op"), value: formData.get("value"), days: formData.get("days") } : { kind, direction: formData.get("direction"), sensitivity: formData.get("sensitivity"), baselineDays: formData.get("baselineDays") });
    const name = String(formData.get("name") ?? "").trim();
    const metric = String(formData.get("metric") ?? "");
    if (!condition.success || !name) return fail("invalid_input");
    const channels = ["in_app", "email", "slack"].filter((c) => formData.get(`ch_${c}`) === "on");
    const recipients = formData.getAll("recipients").map(String).filter((r) => z.string().uuid().safeParse(r).success);
    await ctx.run(async (tx) => {
      const id = await saveAlertRule(svc(ctx, tx), { name, metric, condition: condition.data, channels: channels.length ? channels : ["in_app"], recipients: recipients.length ? recipients : [ctx.user.id], cooldownHours: Number(formData.get("cooldownHours") || 24), isActive: true });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "alert_rule.saved", entityType: "alert_rule", entityId: id, diff: { condition: { from: null, to: condition.data } }, metadata: { metric, channels } });
    });
    revalidatePath(`/t/${slug}/analytics/alerts`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function toggleAlertRuleAction(slug: string, id: string, active: boolean): Promise<ActionResult> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    await ctx.run(async (tx) => {
      await tx.update(schema.alertRules).set({ isActive: active, updatedAt: new Date() }).where(and(eq(schema.alertRules.tenantId, ctx.tenant.id), eq(schema.alertRules.id, id)));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: active ? "alert_rule.enabled" : "alert_rule.disabled", entityType: "alert_rule", entityId: id });
    });
    revalidatePath(`/t/${slug}/analytics/alerts`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function deleteAlertRuleAction(slug: string, id: string): Promise<ActionResult> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    await ctx.run(async (tx) => {
      await deleteAlertRule(svc(ctx, tx), id);
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "alert_rule.deleted", entityType: "alert_rule", entityId: id });
    });
    revalidatePath(`/t/${slug}/analytics/alerts`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Evaluates now, ignoring the cooldown when `force`. */
export async function runAlertsNowAction(slug: string): Promise<ActionResult<{ evaluated: number; fired: number }>> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    const r = await ctx.run((tx) => evaluateAlertRules(svc(ctx, tx), at(ctx), { force: true, appUrl: `${appUrl()}/t/${slug}` }));
    revalidatePath(`/t/${slug}/analytics/alerts`);
    return ok({ evaluated: r.evaluated, fired: r.fired.length });
  } catch (e) {
    return handle(e) as ActionResult<{ evaluated: number; fired: number }>;
  }
}

/** Slack incoming webhook for alert delivery, stored encrypted as integration `slack`. */
export async function saveSlackWebhookAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireAnalyticsWrite(slug);
    const url = String(formData.get("webhookUrl") ?? "").trim();
    if (url && !/^https:\/\/hooks\.slack\.com\//.test(url)) return fail("invalid_input");
    await ctx.run(async (tx) => {
      const values = { tenantId: ctx.tenant.id, provider: "slack", status: url ? "connected" : "not_connected", mode: url && process.env.HULLWISE_INTEGRATION_MODE === "live" ? "live" : "mock", credentialsEncrypted: url ? encryptJson({ webhookUrl: url }) : null, externalAccountName: url ? "Slack webhook" : null };
      await tx.insert(schema.integrations).values(values).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: { status: values.status, mode: values.mode, credentialsEncrypted: values.credentialsEncrypted, externalAccountName: values.externalAccountName } });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: url ? "integration.slack_connected" : "integration.slack_disconnected", entityType: "integration" });
    });
    revalidatePath(`/t/${slug}/analytics/alerts`);
    return ok();
  } catch (e) {
    return handle(e);
  }
}
