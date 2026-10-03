import { and, eq, inArray, or, recordAudit, schema, sql } from "@hullwise/db";
import type { ServiceContext } from "../context";

/**
 * Erasure of one customer's personal data (GDPR art. 17; Shopify `customers/redact`). Inside the tenant's
 * RLS transaction: the customer row and its orders keep their ids, amounts, dates, statuses, country and
 * lines (analytics, P&L and accounting stay right), and lose everything that identifies the person:
 * name, email, phone, addresses, notes written by the customer, IBAN, raw webhook payloads, conversion
 * payloads, browser links, message recipients. Idempotent: running it again changes nothing.
 *
 * Kept on purpose: the tenant's suppression entries for the address (an opt-out must keep being honoured),
 * staff notes, timeline diffs and audit entries (staff-written records; reviewed by hand when asked).
 */
export interface CustomerRedactionInput {
  customerId?: string | null;
  /** The platform's customer id (Shopify `customer.id`). */
  customerExternalId?: string | null;
  /** Platform order ids to redact as well (Shopify `orders_to_redact`), also guest orders with no customer. */
  orderExternalIds?: readonly (string | number)[];
  /** Who asked, for the audit entry (default: the context's user, or the system for a platform webhook). */
  audit?: { actorType: "user" | "impersonation" | "super_admin"; impersonatedBy?: string | null; source?: string };
}

export interface CustomerRedactionReport {
  customerId: string | null;
  orders: number;
  returns: number;
  webhookPayloads: number;
  conversionPayloads: number;
  browserLinks: number;
  messages: number;
  riskProfiles: number;
  surveyAnswers: number;
}

const REDACTED_PAYLOAD = { redacted: true };

export async function redactCustomer(ctx: ServiceContext, input: CustomerRedactionInput): Promise<CustomerRedactionReport> {
  const t = ctx.tenantId;
  const now = ctx.now ?? new Date();
  const c = schema.customers;
  const customerCond = input.customerId ? eq(c.id, input.customerId) : input.customerExternalId ? eq(c.externalId, String(input.customerExternalId)) : null;
  const [customer] = customerCond ? await ctx.tx.select({ id: c.id, externalId: c.externalId, emailNormalized: c.emailNormalized, phoneE164: c.phoneE164 }).from(c).where(and(eq(c.tenantId, t), customerCond)).limit(1) : [];
  const orderExternalIds = [...new Set((input.orderExternalIds ?? []).map(String).filter(Boolean))];

  const o = schema.orders;
  const orderConds = [...(customer ? [eq(o.customerId, customer.id)] : []), ...(orderExternalIds.length ? [inArray(o.externalId, orderExternalIds)] : [])];
  const orders = orderConds.length ? await ctx.tx.select({ id: o.id, externalId: o.externalId, emailNormalized: o.emailNormalized, phoneE164: o.phoneE164 }).from(o).where(and(eq(o.tenantId, t), or(...orderConds))) : [];
  const orderIds = orders.map((r) => r.id);
  const orderExt = [...new Set([...orderExternalIds, ...orders.flatMap((r) => (r.externalId ? [r.externalId] : []))])];
  // the identities the add-on tables key on, read before they are erased
  const phones = [...new Set([customer?.phoneE164, ...orders.map((r) => r.phoneE164)].filter((v): v is string => !!v))];
  const emails = [...new Set([customer?.emailNormalized, ...orders.map((r) => r.emailNormalized)].filter((v): v is string => !!v))];

  const report: CustomerRedactionReport = { customerId: customer?.id ?? null, orders: orderIds.length, returns: 0, webhookPayloads: 0, conversionPayloads: 0, browserLinks: 0, messages: 0, riskProfiles: 0, surveyAnswers: 0 };
  if (!customer && !orderIds.length && !orderExt.length) return report;

  if (orderIds.length) {
    await ctx.tx
      .update(o)
      .set({ customerName: null, email: null, emailNormalized: null, phone: null, phoneE164: null, shippingAddress: null, billingAddress: null, shippingZip: null, shippingCity: null, addressKey: null, nameZipKey: null, note: null, noteAttributes: [], updatedAt: now })
      .where(and(eq(o.tenantId, t), inArray(o.id, orderIds)));
    const rr = schema.returnRequests;
    report.returns = (await ctx.tx.update(rr).set({ bankDetailsEnc: null, customerNote: null, customFields: {}, updatedAt: now }).where(and(eq(rr.tenantId, t), inArray(rr.orderId, orderIds))).returning({ id: rr.id })).length;
    const ce = schema.conversionEvents;
    report.conversionPayloads = (await ctx.tx.update(ce).set({ payload: null }).where(and(eq(ce.tenantId, t), inArray(ce.orderId, orderIds), sql`${ce.payload} is not null`)).returning({ id: ce.id })).length;
    const sr = schema.surveyResponses;
    report.surveyAnswers = (await ctx.tx.update(sr).set({ otherText: null }).where(and(eq(sr.tenantId, t), inArray(sr.orderId, orderIds), sql`${sr.otherText} is not null`)).returning({ id: sr.id })).length;
    // a new delivery address given to the carrier for a stuck shipment
    const sc = schema.shipmentCases;
    await ctx.tx.update(sc).set({ resolutionDetail: sql`${sc.resolutionDetail} || '{"address": null}'::jsonb`, updatedAt: now }).where(and(eq(sc.tenantId, t), inArray(sc.orderId, orderIds), sql`${sc.resolutionDetail} -> 'address' <> 'null'::jsonb`));
    const cm = schema.codMessages;
    report.messages += (await ctx.tx.update(cm).set({ recipient: "", body: "" }).where(and(eq(cm.tenantId, t), inArray(cm.orderId, orderIds), sql`${cm.recipient} <> ''`)).returning({ id: cm.id })).length;
  }
  if (customer) {
    await ctx.tx.update(c).set({ email: null, emailNormalized: null, phone: null, phoneE164: null, firstName: null, lastName: null, city: null, zip: null, acceptsMarketing: false, updatedAt: now }).where(and(eq(c.tenantId, t), eq(c.id, customer.id)));
  }

  // WhatsApp messages (Spoki add-on) to the customer or about the orders
  const sm = schema.spokiMessages;
  const smConds = [...(customer ? [eq(sm.customerId, customer.id)] : []), ...(orderIds.length ? [inArray(sm.orderId, orderIds)] : [])];
  if (smConds.length) report.messages += (await ctx.tx.update(sm).set({ phone: "", body: null }).where(and(eq(sm.tenantId, t), or(...smConds), sql`${sm.phone} <> ''`)).returning({ id: sm.id })).length;

  // recipient risk profiles (COD add-on) keyed on the phone or `email:<address>`
  const keys = [...phones, ...emails.map((e) => `email:${e}`)];
  if (keys.length) {
    const rp = schema.codRecipientProfiles;
    report.riskProfiles = (await ctx.tx.delete(rp).where(and(eq(rp.tenantId, t), inArray(rp.recipientKey, keys))).returning({ id: rp.id })).length;
  }

  // browser ↔ person links of the storefront pixel, and the checkout IPs of those browsers
  const pi = schema.pixelIdentities;
  const piConds = [...(customer ? [eq(pi.customerId, customer.id)] : []), ...(orderExt.length ? [inArray(pi.orderExternalId, orderExt)] : [])];
  if (piConds.length) {
    const links = await ctx.tx.delete(pi).where(and(eq(pi.tenantId, t), or(...piConds))).returning({ anonymousId: pi.anonymousId });
    report.browserLinks = links.length;
    const anon = [...new Set(links.map((l) => l.anonymousId))];
    if (anon.length) await ctx.tx.update(schema.pixelEvents).set({ clientIp: null, userAgent: null }).where(and(eq(schema.pixelEvents.tenantId, t), inArray(schema.pixelEvents.anonymousId, anon)));
  }

  // raw platform payloads (orders, refunds, fulfillments, the customer itself) still kept for retries
  const we = schema.webhookEvents;
  const ids = [...orderExt, ...(customer?.externalId ? [customer.externalId] : [])];
  if (ids.length) {
    report.webhookPayloads = (
      await ctx.tx
        .update(we)
        .set({ payload: REDACTED_PAYLOAD, status: "processed", processedAt: sql`coalesce(${we.processedAt}, ${now})`, lastError: sql`case when ${we.status} = 'processed' then ${we.lastError} else 'redacted before processing' end` })
        .where(and(eq(we.tenantId, t), eq(we.source, "shopify"), or(inArray(we.externalId, ids), inArray(sql`${we.payload} ->> 'order_id'`, orderExt.length ? orderExt : ["-"])), sql`${we.payload} <> ${JSON.stringify(REDACTED_PAYLOAD)}::jsonb`))
        .returning({ id: we.id })
    ).length;
  }

  await recordAudit(ctx.tx, { tenantId: t, actorUserId: ctx.actor.userId, actorType: input.audit?.actorType ?? (ctx.actor.userId ? "user" : "system"), impersonatedBy: input.audit?.impersonatedBy ?? null, action: "customer.redacted", entityType: "customer", entityId: customer?.id ?? "guest", diff: { personalData: { from: "present", to: "erased" } }, metadata: { ...report, customerExternalId: customer?.externalId ?? input.customerExternalId ?? null, orderExternalIds: orderExt, source: input.audit?.source ?? (ctx.actor.userId ? "manual" : "platform") } });
  return report;
}

export class CustomerErasureError extends Error {
  constructor(readonly code: "not_found" | "confirmation_mismatch") {
    super(code);
    this.name = "CustomerErasureError";
  }
}

/** What the person erasing must type: the customer's email, else the phone, else the first 8 characters of the id. */
export function erasureConfirmationFor(c: { id: string; email: string | null; phone: string | null }): string {
  return c.email ?? c.phone ?? c.id.slice(0, 8);
}

/**
 * Erasure asked outside the store platform (the customer wrote to the merchant, or to the platform owner):
 * the same erasure as `customers/redact`, after a typed confirmation of the customer's email. Audited as the
 * person who did it (user, impersonating super-admin, or super-admin from the console).
 */
export async function eraseCustomerOnRequest(ctx: ServiceContext, input: { customerId: string; confirmation: string; audit: { actorType: "user" | "impersonation" | "super_admin"; impersonatedBy?: string | null } }): Promise<CustomerRedactionReport> {
  const c = schema.customers;
  const [customer] = await ctx.tx.select({ id: c.id, email: c.email, phone: c.phone }).from(c).where(and(eq(c.tenantId, ctx.tenantId), eq(c.id, input.customerId))).limit(1);
  if (!customer) throw new CustomerErasureError("not_found");
  if (input.confirmation.trim().toLowerCase() !== erasureConfirmationFor(customer).trim().toLowerCase()) throw new CustomerErasureError("confirmation_mismatch");
  return redactCustomer(ctx, { customerId: customer.id, audit: { ...input.audit, source: "request" } });
}

/** The console's lookup for an erasure: customers of the tenant whose email matches exactly (normalized). */
export async function findCustomersByEmail(ctx: ServiceContext, email: string) {
  const c = schema.customers;
  const e = email.trim().toLowerCase();
  if (!e) return [];
  return ctx.tx.select({ id: c.id, email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName, ordersCount: c.ordersCount, externalId: c.externalId }).from(c).where(and(eq(c.tenantId, ctx.tenantId), or(eq(c.emailNormalized, e), eq(sql`lower(${c.email})`, e)))).limit(5);
}
