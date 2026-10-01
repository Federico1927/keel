import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, recordAudit, schema } from "@keel/db";
import { HttpEmailSink, MockNotificationSink, integrationMode, type NotificationSink } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { getNotificationSinks } from "../integrations/factory";
import { renderEmail, type EmailTemplate, type EmailTemplateData, type RenderedEmail } from "./email-templates";

/**
 * Email categories. Transactional mail the person asked for (sign-in, invite) cannot be
 * unsubscribed from; everything else carries a signed unsubscribe link for its category.
 */
export const TRANSACTIONAL_EMAIL = "transactional";
export type EmailCategory = string;

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/* ---------- signed unsubscribe links ---------- */

export interface UnsubscribePayload {
  tenantId: string;
  email: string;
  category: string;
}

function signingSecret(): string {
  const s = process.env.APP_ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!s) throw new Error("APP_ENCRYPTION_KEY or AUTH_SECRET is required to sign unsubscribe links");
  return s;
}
const mac = (body: string) => createHmac("sha256", `unsubscribe:${signingSecret()}`).update(body).digest("base64url").slice(0, 32);

/** `<base64url(json)>.<hmac>`: per recipient and category, no expiry (unsubscribe links must keep working). */
export function signUnsubscribeToken(p: UnsubscribePayload): string {
  const body = Buffer.from(JSON.stringify({ t: p.tenantId, e: p.email.trim().toLowerCase(), c: p.category })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 2000) return null;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const j = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { t?: unknown; e?: unknown; c?: unknown };
    if (typeof j.t !== "string" || !/^[0-9a-f-]{36}$/i.test(j.t) || typeof j.e !== "string" || typeof j.c !== "string") return null;
    return { tenantId: j.t, email: j.e, category: j.c };
  } catch {
    return null;
  }
}

/** Link in the email body: a page that asks for confirmation. */
export function unsubscribeUrl(p: UnsubscribePayload): string {
  return `${appBaseUrl()}/u/${signUnsubscribeToken(p)}`;
}

/** `List-Unsubscribe` header target: RFC 8058 one-click POST. */
export function oneClickUnsubscribeUrl(p: UnsubscribePayload): string {
  return `${appBaseUrl()}/api/email/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(p))}`;
}

/* ---------- suppression list ---------- */

const norm = (e: string) => e.trim().toLowerCase();

/** Bounces and complaints block everything; unsubscribes and manual entries block their category (or all optional mail). */
export async function isEmailSuppressed(ctx: ServiceContext, email: string, category: EmailCategory): Promise<boolean> {
  const rows = await ctx.tx.select({ reason: schema.emailSuppressions.reason, category: schema.emailSuppressions.category }).from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.email, norm(email))));
  return rows.some((r) => r.reason === "bounce" || r.reason === "complaint" || (category !== TRANSACTIONAL_EMAIL && (r.category === "all" || r.category === category)));
}

export async function suppressedAmong(ctx: ServiceContext, emails: string[], category: EmailCategory): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = await ctx.tx.select({ email: schema.emailSuppressions.email, reason: schema.emailSuppressions.reason, category: schema.emailSuppressions.category }).from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), inArray(schema.emailSuppressions.email, emails.map(norm))));
  return new Set(rows.filter((r) => r.reason === "bounce" || r.reason === "complaint" || (category !== TRANSACTIONAL_EMAIL && (r.category === "all" || r.category === category))).map((r) => r.email));
}

export const SUPPRESSION_REASONS = ["bounce", "complaint", "unsubscribe", "manual"] as const;

export async function addEmailSuppression(ctx: ServiceContext, input: { email: string; reason: (typeof SUPPRESSION_REASONS)[number]; category?: string; source?: string; note?: string | null }): Promise<boolean> {
  const email = norm(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_email");
  const category = input.reason === "bounce" || input.reason === "complaint" ? "all" : (input.category ?? "all");
  const rows = await ctx.tx.insert(schema.emailSuppressions).values({ tenantId: ctx.tenantId, email, reason: input.reason, category, source: input.source ?? "app", note: input.note ?? null, createdBy: ctx.actor.userId, createdAt: ctx.now ?? new Date() }).onConflictDoNothing().returning({ id: schema.emailSuppressions.id });
  if (rows.length) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", action: "email.suppressed", entityType: "email_suppression", entityId: rows[0]!.id, diff: { suppressed: { from: false, to: true } }, metadata: { email, reason: input.reason, category, source: input.source ?? "app" } });
  return rows.length > 0;
}

export async function removeEmailSuppression(ctx: ServiceContext, id: string): Promise<boolean> {
  const [row] = await ctx.tx.delete(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.id, id))).returning();
  if (row) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "email.unsuppressed", entityType: "email_suppression", entityId: id, diff: { suppressed: { from: true, to: false } }, metadata: { email: row.email, reason: row.reason, category: row.category } });
  return Boolean(row);
}

export async function listEmailSuppressions(ctx: ServiceContext, limit = 200) {
  return ctx.tx.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.tenantId, ctx.tenantId)).orderBy(desc(schema.emailSuppressions.createdAt)).limit(limit);
}

/** Deletes the unsubscribe entries of one address (the person subscribes again from their preferences). */
export async function clearUnsubscribes(ctx: ServiceContext, email: string): Promise<void> {
  await ctx.tx.delete(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.email, norm(email)), eq(schema.emailSuppressions.reason, "unsubscribe")));
}

/* ---------- sending ---------- */

export type EmailOutcome = "sent" | "mock" | "suppressed" | "error";

/**
 * Renders a template and sends it through the tenant's email sink (the platform provider in live
 * mode, a recording mock otherwise), unless the address is suppressed for the category.
 */
export async function sendTenantEmail<K extends EmailTemplate>(ctx: ServiceContext, input: { to: string; template: K; data: EmailTemplateData[K]; locale: string | null | undefined; category: EmailCategory; sink?: NotificationSink; mock?: boolean }): Promise<{ outcome: EmailOutcome; rendered: RenderedEmail | null; error?: string }> {
  const to = norm(input.to);
  if (await isEmailSuppressed(ctx, to, input.category)) return { outcome: "suppressed", rendered: null };
  const unsub = input.category === TRANSACTIONAL_EMAIL ? undefined : unsubscribeUrl({ tenantId: ctx.tenantId, email: to, category: input.category });
  const rendered = renderEmail(input.template, input.locale, input.data, { unsubscribeUrl: unsub });
  let sink = input.sink;
  let mock = input.mock ?? false;
  if (!sink) {
    const sinks = await getNotificationSinks(ctx);
    sink = sinks.email;
    mock = sinks.mock.email;
  }
  try {
    await sink.send([to], { subject: rendered.subject, text: rendered.text, html: rendered.html, headers: unsub ? { "List-Unsubscribe": `<${oneClickUnsubscribeUrl({ tenantId: ctx.tenantId, email: to, category: input.category })}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined, tags: { tenant_id: ctx.tenantId, category: input.category } });
    return { outcome: mock ? "mock" : "sent", rendered };
  } catch (e) {
    return { outcome: "error", rendered, error: e instanceof Error ? e.message : String(e) };
  }
}

const platformMock = new MockNotificationSink("email");

/** Platform mail outside any tenant (sign-in links). Mock in mock mode or without a provider key. */
export async function sendPlatformEmail<K extends EmailTemplate>(input: { to: string; template: K; data: EmailTemplateData[K]; locale: string | null | undefined }): Promise<{ outcome: EmailOutcome; rendered: RenderedEmail }> {
  const rendered = renderEmail(input.template, input.locale, input.data);
  const live = integrationMode() === "live" && Boolean(process.env.KEEL_EMAIL_API_KEY);
  const sink: NotificationSink = live ? new HttpEmailSink({ apiKey: process.env.KEEL_EMAIL_API_KEY!, from: process.env.KEEL_EMAIL_FROM ?? "no-reply@keel.app" }) : platformMock;
  await sink.send([norm(input.to)], { subject: rendered.subject, text: rendered.text, html: rendered.html, tags: { category: TRANSACTIONAL_EMAIL } });
  return { outcome: live ? "sent" : "mock", rendered };
}

export function platformMockEmails(): MockNotificationSink {
  return platformMock;
}
