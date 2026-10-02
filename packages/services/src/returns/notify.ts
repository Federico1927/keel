import { and, eq, schema } from "@keel/db";
import { brandColorsFor, isHexColor, parsePortalConfig, parseTenantSettings, pickLocalized, type ReturnEmailEvent } from "@keel/core";
import { BRAND_SURFACES } from "@keel/ui/tokens";
import type { ServiceContext } from "../context";
import { getTenantBranding } from "../branding";
import { queueEmail, type QueueOutcome } from "../email/mailer";
import { RETURN_EMAIL_CATEGORY, type EmailBrand, type EmailTemplate, type EmailTemplateData, type ReturnEmailBase } from "../email/templates";
import { appBaseUrl } from "../email/unsubscribe";
import { signReturnLink } from "./customer";

/**
 * Status emails to the customer who asked for a return (issue #7): approved (with the prepaid
 * label when there is one), received, refunded, store credit issued, replacement shipped. One email
 * per return and event (the mailer's idempotency key), only when the store switched the event on
 * (`returnCustomerEmails`), in the customer's language (the portal locale, else the store's), with
 * the store's identity: its name as sender name on the platform address, its portal support address
 * as reply-to, the portal / branding colour and logo. Suppressed addresses are skipped by the mailer.
 */
export type ReturnEmailOutcome = QueueOutcome | "disabled" | "no_recipient";

const TEMPLATE: Record<ReturnEmailEvent, EmailTemplate> = {
  approved: "return_approved",
  received: "return_received",
  refunded: "return_refunded",
  voucher_issued: "return_voucher_issued",
  exchange_shipped: "return_exchange_shipped",
};

/** The email a return status triggers, if any (`exchanged` waits for the replacement to ship). */
export function returnEmailEventFor(status: string): ReturnEmailEvent | null {
  return status === "approved" || status === "received" || status === "refunded" || status === "voucher_issued" ? status : null;
}

export async function notifyReturnCustomer(ctx: ServiceContext, returnId: string, event: ReturnEmailEvent, extra: { shipment?: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null }; exchangeOrderName?: string | null } = {}): Promise<{ outcome: ReturnEmailOutcome; messageId?: string }> {
  const [tenant] = await ctx.tx.select({ name: schema.tenants.name, slug: schema.tenants.slug, defaultLocale: schema.tenants.defaultLocale, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  if (!tenant || !parseTenantSettings(tenant.settings).returnCustomerEmails[event]) return { outcome: "disabled" };
  const [r] = await ctx.tx.select().from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  if (!r) return { outcome: "no_recipient" };
  const [order] = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, email: schema.orders.email, customerName: schema.orders.customerName, currency: schema.orders.currency }).from(schema.orders).where(eq(schema.orders.id, r.orderId)).limit(1);
  if (!order?.email) return { outcome: "no_recipient" };
  const [portalRow] = await ctx.tx.select({ config: schema.returnPortalSettings.config }).from(schema.returnPortalSettings).where(eq(schema.returnPortalSettings.tenantId, ctx.tenantId)).limit(1);
  const portal = parsePortalConfig(portalRow?.config);
  const locale = r.customerLocale ?? tenant.defaultLocale;
  const base = appBaseUrl();
  const slug = encodeURIComponent(tenant.slug);

  const items = event === "exchange_shipped"
    ? await ctx.tx.select({ title: schema.returnExchangeLines.title, quantity: schema.returnExchangeLines.quantity }).from(schema.returnExchangeLines).where(and(eq(schema.returnExchangeLines.tenantId, ctx.tenantId), eq(schema.returnExchangeLines.returnId, r.id)))
    : await ctx.tx.select({ title: schema.orderLines.title, quantity: schema.returnLines.quantity }).from(schema.returnLines).innerJoin(schema.orderLines, eq(schema.orderLines.id, schema.returnLines.orderLineId)).where(eq(schema.returnLines.returnId, r.id));
  const common: ReturnEmailBase = { storeName: tenant.name, customerName: order.customerName?.split(/\s+/)[0] ?? null, returnNumber: `R-${r.number}`, orderName: order.name, items };
  const amountMinor = r.refundedAmountMinor ?? 0;
  const data: EmailTemplateData[typeof TEMPLATE[ReturnEmailEvent]] =
    event === "approved" ? { ...common, labelUrl: r.labelProvider && r.trackingCode ? `${base}/r/${slug}/label/${r.id}?sig=${signReturnLink(ctx.tenantId, r.id)}` : null, instructions: pickLocalized(portal.instructions, locale, tenant.defaultLocale) || null }
    : event === "refunded" ? { ...common, amountMinor, currency: order.currency }
    : event === "voucher_issued" ? { ...common, amountMinor, currency: order.currency, code: r.voucherCode ?? "" }
    : event === "exchange_shipped" ? { ...common, exchangeOrderName: extra.exchangeOrderName ?? null, carrier: extra.shipment?.carrier ?? null, trackingNumber: extra.shipment?.trackingNumber ?? null, trackingUrl: extra.shipment?.trackingUrl ?? (portal.trackingPage ? `${base}/r/${slug}/track` : null) }
    : common;

  const branding = await getTenantBranding(ctx);
  const color = portal.primaryColor && isHexColor(portal.primaryColor) ? portal.primaryColor : branding.brandColor && isHexColor(branding.brandColor) ? branding.brandColor : null;
  const logoUrl = portal.logoUrl ?? (branding.logoLight ? `${base}/brand/${slug}/light?v=${branding.logoLight.version}` : null);
  const light = color ? brandColorsFor(color, BRAND_SURFACES.light) : null;
  const dark = color ? brandColorsFor(color, BRAND_SURFACES.dark) : null;
  const brand: EmailBrand | null = color || logoUrl ? { primary: light?.primary, onPrimary: light?.onPrimary, primaryDark: dark?.primary, onPrimaryDark: dark?.onPrimary, logoUrl } : null;
  const sender = { product: tenant.name, legalName: tenant.name, legalAddress: null, supportEmail: portal.supportEmail, brand };

  const queued = await queueEmail(ctx, { to: order.email, template: TEMPLATE[event], data: data as never, locale, event: `return:${r.id}:${event}`, category: RETURN_EMAIL_CATEGORY, sender, fromName: tenant.name, replyTo: portal.supportEmail });
  // the timeline says what the customer was told (or why not); a replay adds nothing
  if (queued.outcome !== "duplicate") await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId: order.id, type: "customer_email", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, diff: {}, metadata: { returnId: r.id, number: r.number, event, template: TEMPLATE[event], outcome: queued.outcome, messageId: queued.id }, createdAt: ctx.now ?? new Date() });
  return { outcome: queued.outcome, messageId: queued.id };
}

/** Emails the customer about the return's current status (portal returns, once the label exists). */
export async function notifyReturnStatus(ctx: ServiceContext, returnId: string): Promise<ReturnEmailOutcome | null> {
  const [r] = await ctx.tx.select({ status: schema.returnRequests.status }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.id, returnId))).limit(1);
  const event = r ? returnEmailEventFor(r.status) : null;
  return event ? (await notifyReturnCustomer(ctx, returnId, event)).outcome : null;
}

/** A shipment of an exchange order: the customer of each return it replaces hears it is on its way (once per return). */
export async function notifyExchangeShipped(ctx: ServiceContext, orderId: string, shipment: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null }): Promise<number> {
  const returns = await ctx.tx.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), eq(schema.returnRequests.exchangeOrderId, orderId)));
  if (!returns.length) return 0;
  const [o] = await ctx.tx.select({ name: schema.orders.name }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  let queued = 0;
  for (const r of returns) if ((await notifyReturnCustomer(ctx, r.id, "exchange_shipped", { shipment, exchangeOrderName: o?.name ?? null })).outcome === "queued") queued++;
  return queued;
}
