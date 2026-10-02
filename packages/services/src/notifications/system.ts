import { and, eq, inArray, isNull, schema, sql } from "@hullwise/db";
import { digestSummary, isCriticalWithoutIncoming, type TenantSettings } from "@hullwise/core";
import { countLateToShip } from "../fulfilment";
import type { TenantRole } from "@hullwise/config";
import type { ServiceContext } from "../context";
import { variantStock } from "../inventory";
import { notifyUsers, absoluteAppLink } from "./index";
import { queueEmail } from "../email/mailer";
import { appBaseUrl } from "../email/unsubscribe";

/** Active members with one of the roles (system notifications go to the people who can act). */
export async function membersWithRoles(ctx: ServiceContext, roles: readonly TenantRole[]): Promise<string[]> {
  const rows = await ctx.tx.select({ userId: schema.tenantMemberships.userId }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.isActive, true), inArray(schema.tenantMemberships.role, [...roles])));
  return rows.map((r) => r.userId);
}

const sys = (ctx: ServiceContext): ServiceContext => ({ ...ctx, actor: { type: "system", userId: null } });

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
    // one digest per user and day: a second run of the tick the same day is a no-op
    const r = await queueEmail(ctx, { to: u.email, template: "digest", data: { tenantName: tenant?.name ?? "", groups: digestSummary(items), url: absoluteAppLink("/notifications", tenant?.slug ?? "") ?? appBaseUrl() }, locale: u.locale ?? tenant?.defaultLocale, event: `digest:${userId}:${now.toISOString().slice(0, 10)}` });
    if (r.outcome === "queued") sent++;
  }
  return sent;
}
