import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb, and, eq, schema, sql } from "@hullwise/db";
import { DEFAULT_SURVEY_CONFIG, SALE_STATUSES, surveyConfigSchema, surveyCrosstab, surveyText, type Period, type SurveyConfig } from "@hullwise/core";
import type { ServiceContext } from "../context";

const SALE = SALE_STATUSES as readonly string[];

export class SurveyError extends Error {
  constructor(public readonly code: "disabled" | "invalid_link" | "not_found" | "invalid_answer" | "invalid_config") {
    super(code);
  }
}

/**
 * Survey link signature: HMAC-SHA256 of the platform order id with the store's secret, as hex.
 * It matches what Shopify's Liquid `hmac_sha256` filter produces in the order confirmation email,
 * so the link can be built there without Hullwise being called (to verify against current Liquid docs).
 */
export function surveySignature(secret: string, orderExternalId: string): string {
  return createHmac("sha256", secret).update(orderExternalId).digest("hex");
}

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function getSurveySettings(ctx: ServiceContext): Promise<{ enabled: boolean; config: SurveyConfig; secret: string }> {
  const [row] = await ctx.tx.select().from(schema.surveySettings).where(eq(schema.surveySettings.tenantId, ctx.tenantId)).limit(1);
  if (row) {
    const parsed = surveyConfigSchema.safeParse(row.config);
    return { enabled: row.enabled, config: parsed.success ? parsed.data : DEFAULT_SURVEY_CONFIG, secret: row.secret };
  }
  const [created] = await ctx.tx.insert(schema.surveySettings).values({ tenantId: ctx.tenantId, enabled: false, config: DEFAULT_SURVEY_CONFIG, secret: randomBytes(24).toString("hex") }).returning();
  return { enabled: created!.enabled, config: DEFAULT_SURVEY_CONFIG, secret: created!.secret };
}

export async function saveSurveySettings(ctx: ServiceContext, input: { enabled: boolean; config: unknown }): Promise<void> {
  const parsed = surveyConfigSchema.safeParse(input.config);
  if (!parsed.success) throw new SurveyError("invalid_config");
  const keys = parsed.data.options.map((o) => o.key);
  if (new Set(keys).size !== keys.length) throw new SurveyError("invalid_config");
  await getSurveySettings(ctx);
  await ctx.tx.update(schema.surveySettings).set({ enabled: input.enabled, config: parsed.data, updatedAt: new Date() }).where(eq(schema.surveySettings.tenantId, ctx.tenantId));
}

/** Cross-tenant: the store behind a public survey link (slug), like the return portal. */
export async function surveyTenantForSlug(slug: string): Promise<{ id: string; name: string; defaultLocale: string } | null> {
  const [t] = await adminDb().select({ id: schema.tenants.id, name: schema.tenants.name, defaultLocale: schema.tenants.defaultLocale, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  return t && t.status === "active" ? { id: t.id, name: t.name, defaultLocale: t.defaultLocale } : null;
}

export interface PublicSurveyView {
  question: string;
  thanks: string;
  options: { key: string; label: string }[];
  allowOther: boolean;
  answered: boolean;
}

async function resolveLink(ctx: ServiceContext, orderExternalId: string, signature: string) {
  const s = await getSurveySettings(ctx);
  if (!s.enabled) throw new SurveyError("disabled");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderExternalId) || !/^[a-f0-9]{64}$/.test(signature) || !sameSignature(surveySignature(s.secret, orderExternalId), signature)) throw new SurveyError("invalid_link");
  const [order] = await ctx.tx.select({ id: schema.orders.id, customerId: schema.orders.customerId }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.externalId, orderExternalId))).limit(1);
  if (!order) throw new SurveyError("not_found");
  return { settings: s, order };
}

export async function publicSurveyView(ctx: ServiceContext, orderExternalId: string, signature: string, locale: string): Promise<PublicSurveyView> {
  const { settings, order } = await resolveLink(ctx, orderExternalId, signature);
  const [existing] = await ctx.tx.select({ id: schema.surveyResponses.id }).from(schema.surveyResponses).where(and(eq(schema.surveyResponses.tenantId, ctx.tenantId), eq(schema.surveyResponses.orderId, order.id))).limit(1);
  const c = settings.config;
  return { question: surveyText(c.question, locale), thanks: surveyText(c.thanks, locale), options: c.options.map((o) => ({ key: o.key, label: surveyText(o.labels, locale) })), allowOther: c.allowOther, answered: !!existing };
}

/** Records the answer; the first answer of an order is kept, later ones are ignored. */
export async function submitSurveyAnswer(ctx: ServiceContext, input: { orderExternalId: string; signature: string; answerKey: string; otherText?: string | null; locale: string; source?: "email_link" | "thank_you" | "staff" }): Promise<{ recorded: boolean }> {
  const { settings, order } = await resolveLink(ctx, input.orderExternalId, input.signature);
  const option = settings.config.options.find((o) => o.key === input.answerKey);
  const other = input.answerKey === "other" && settings.config.allowOther;
  if (!option && !other) throw new SurveyError("invalid_answer");
  const rows = await ctx.tx
    .insert(schema.surveyResponses)
    .values({ tenantId: ctx.tenantId, orderId: order.id, customerId: order.customerId, answerKey: input.answerKey, channel: option?.channel ?? "other", otherText: other ? (input.otherText ?? "").trim().slice(0, 300) || null : null, locale: input.locale.slice(0, 5), source: input.source ?? "email_link", respondedAt: ctx.now ?? new Date() })
    .onConflictDoNothing()
    .returning({ id: schema.surveyResponses.id });
  return { recorded: rows.length > 0 };
}

export interface SurveyResults {
  orders: number;
  responses: number;
  answers: { key: string; label: string; channel: string; responses: number; revenueMinor: number }[];
  crosstab: { channel: string; answers: number; agree: number; invisible: number }[];
  others: string[];
}

/** Answers for orders placed in the period, with what their clicks said for comparison. */
export async function surveyResults(ctx: ServiceContext, period: Period, locale: string): Promise<SurveyResults> {
  const { config } = await getSurveySettings(ctx);
  const t = ctx.tenantId;
  const [o] = (await ctx.tx.execute<{ n: number }>(sql`select count(*)::int as n from orders where tenant_id = ${t} and placed_at >= ${period.from} and placed_at < ${period.to} and status in ${SALE}`)).rows;
  const rows = await ctx.tx.execute<{ answer_key: string; channel: string; other_text: string | null; total: number; click: string | null }>(sql`
    select r.answer_key, r.channel, r.other_text, o.total_minor as total, a.channel as click
    from survey_responses r join orders o on o.id = r.order_id left join order_attribution a on a.order_id = o.id
    where r.tenant_id = ${t} and o.placed_at >= ${period.from} and o.placed_at < ${period.to} and o.status in ${SALE}`);
  const by = new Map<string, { key: string; label: string; channel: string; responses: number; revenueMinor: number }>();
  for (const r of rows.rows) {
    const opt = config.options.find((x) => x.key === r.answer_key);
    const row = by.get(r.answer_key) ?? { key: r.answer_key, label: opt ? surveyText(opt.labels, locale) : r.answer_key, channel: r.channel, responses: 0, revenueMinor: 0 };
    row.responses++;
    row.revenueMinor += Number(r.total);
    by.set(r.answer_key, row);
  }
  return {
    orders: o?.n ?? 0,
    responses: rows.rows.length,
    answers: [...by.values()].sort((a, b) => b.responses - a.responses),
    crosstab: surveyCrosstab(rows.rows.map((r) => ({ answerChannel: r.channel, clickChannel: r.click }))),
    others: rows.rows.map((r) => r.other_text).filter((x): x is string => !!x).slice(0, 20),
  };
}

/** Survey channel per order, for the survey-blend attribution model. */
export async function surveyChannelsFor(ctx: ServiceContext, orderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < orderIds.length; i += 5000) {
    const rows = await ctx.tx.select({ orderId: schema.surveyResponses.orderId, channel: schema.surveyResponses.channel }).from(schema.surveyResponses).where(and(eq(schema.surveyResponses.tenantId, ctx.tenantId), sql`${schema.surveyResponses.orderId} = any(${sql.param(orderIds.slice(i, i + 5000))}::uuid[])`));
    for (const r of rows) out.set(r.orderId, r.channel);
  }
  return out;
}
