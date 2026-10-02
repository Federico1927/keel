import { and, eq, inArray, isNull, schema, sql } from "@keel/db";
import { digestSummary, isCriticalWithoutIncoming, isSyncDelayed, type TenantSettings } from "@keel/core";
import { countLateToShip } from "../fulfilment";
import type { TenantRole } from "@keel/config";
import type { ServiceContext } from "../context";
import { variantStock } from "../inventory";
import { notifyUsers, absoluteAppLink } from "./index";
import { appBaseUrl, sendTenantEmail } from "./mailer";

/** Active members with one of the roles (system notifications go to the people who can act). */
export async function membersWithRoles(ctx: ServiceContext, roles: readonly TenantRole[]): Promise<string[]> {
  const rows = await ctx.tx.select({ userId: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true), inArray(schema.tenantMemberships.role, [...roles])));
  return rows.map((r) => r.userId);
}

const sys = (ctx: ServiceContext): ServiceContext => ({ ...ctx, actor: { type: "system", userId: null } });

/** Integrations whose last successful sync is older than their freshness window plus the tenant's grace. */
export async function checkSyncDelays(ctx: ServiceContext, settings: TenantSettings): Promise<{ source: string; minutesLate: number }[]> {
  const now = ctx.now ?? new Date();
  const integrations = await ctx.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), inArray(schema.integrations.status, ["connected", "error", "syncing"])));
  if (!integrations.length) return [];
  const health = await ctx.tx.select().from(schema.integrationHealth).where(eq(schema.integrationHealth.tenantId, ctx.tenantId));
  const late: { source: string; minutesLate: number }[] = [];
  for (const h of health) {
    const integ = integrations.find((i) => i.provider === h.source.split(":")[0]);
    if (!integ) continue;
    const r = isSyncDelayed({ lastSuccessAt: h.lastSuccessAt, connectedAt: integ.createdAt, freshnessMinutes: h.freshnessMinutes, graceMinutes: settings.syncDelayGraceMinutes, now });
    if (r.delayed) late.push({ source: h.source, minutesLate: r.minutesLate });
  }
  if (late.length) {
    const users = await membersWithRoles(ctx, ["owner", "admin"]);
    for (const l of late) await notifyUsers(sys(ctx), { userIds: users, type: "sync_delay", severity: "warning", title: l.source, body: `+${Math.round(l.minutesLate / 60)}h`, link: `/integrations#${l.source.split(":")[0]}`, metadata: { source: l.source, minutesLate: l.minutesLate }, antiSpamMinutes: 6 * 60 });
  }
  return late;
}

/** Selling variants at critical cover with nothing on order: one grouped notification a day. */
export async function checkCriticalStock(ctx: ServiceContext, settings: TenantSettings): Promise<{ variantId: string; sku: string | null; title: string }[]> {
  const rows = (await variantStock(ctx, settings)).filter(isCriticalWithoutIncoming).sort((a, b) => b.velocityPerDay - a.velocityPerDay);
  const out = rows.map((r) => ({ variantId: r.variantId, sku: r.sku, title: `${r.productTitle}${r.variantTitle ? ` · ${r.variantTitle}` : ""}` }));
  if (out.length) {
    const users = await membersWithRoles(ctx, ["owner", "admin", "operations"]);
    await notifyUsers(sys(ctx), { userIds: users, type: "stock_critical_no_po", severity: "critical", title: String(out.length), body: out.slice(0, 3).map((o) => o.sku ?? o.title).join(", "), link: "/inventory/planning", metadata: { count: out.length, variantIds: out.slice(0, 20).map((o) => o.variantId) }, antiSpamMinutes: 24 * 60 });
  }
  return out;
}

/**
 * Orders ready to ship and still unshipped after the tenant's threshold in working days (tenant time
 * zone): one grouped notification a day. The same query feeds the fulfilment queue and the alert metric.
 */
export async function checkLateToShip(ctx: ServiceContext, settings: TenantSettings, timezone?: string): Promise<number> {
  const now = ctx.now ?? new Date();
  const tz = timezone ?? (await ctx.tx.select({ timezone: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1))[0]?.timezone ?? "UTC";
  const late = await countLateToShip(ctx, { timezone: tz, settings, now });
  if (late) {
    const users = await membersWithRoles(ctx, ["owner", "admin", "operations"]);
    await notifyUsers(sys(ctx), { userIds: users, type: "late_to_ship", severity: "warning", title: String(late), body: String(settings.lateToShipBusinessDays), link: "/fulfilment?view=late", metadata: { count: late, thresholdBusinessDays: settings.lateToShipBusinessDays }, antiSpamMinutes: 24 * 60 });
  }
  return late;
}

/** Daily digest email (opt-in per user): unread in-app notifications of the last 24 hours, grouped by type. */
export async function sendDigests(ctx: ServiceContext): Promise<number> {
  const now = ctx.now ?? new Date();
  const optedIn = await ctx.tx.select({ userId: schema.notificationPreferences.userId }).from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.tenantId, ctx.tenantId), eq(schema.notificationPreferences.type, "digest"), eq(schema.notificationPreferences.email, true)));
  if (!optedIn.length) return 0;
  const [tenant] = await ctx.tx.select({ slug: schema.tenants.slug, name: schema.tenants.name, defaultLocale: schema.tenants.defaultLocale }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  const members = new Set(await membersWithRoles(ctx, ["owner", "admin", "operations", "customer_care", "marketing", "viewer"]));
  let sent = 0;
  for (const { userId } of optedIn) {
    if (!members.has(userId)) continue;
    const items = await ctx.tx.select({ type: schema.notifications.type, title: schema.notifications.title }).from(schema.notifications).where(and(eq(schema.notifications.tenantId, ctx.tenantId), eq(schema.notifications.userId, userId), eq(schema.notifications.inApp, true), isNull(schema.notifications.readAt), sql`${schema.notifications.createdAt} >= ${new Date(now.getTime() - 864e5)}`));
    if (!items.length) continue;
    const [u] = await ctx.tx.select({ email: schema.users.email, locale: schema.users.locale }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!u) continue;
    const r = await sendTenantEmail(ctx, { to: u.email, template: "digest", data: { tenantName: tenant?.name ?? "", groups: digestSummary(items), url: absoluteAppLink("/notifications", tenant?.slug ?? "") ?? appBaseUrl() }, locale: u.locale ?? tenant?.defaultLocale, category: "digest" });
    if (r.outcome === "sent" || r.outcome === "mock") sent++;
  }
  return sent;
}
