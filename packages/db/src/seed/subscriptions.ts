import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { createRng } from "@hullwise/integrations/rng";
import { DEFAULT_CANCELLATION_REASONS, addSubscriptionInterval, addressKey, nameZipKey, normalizeCancellationReason, normalizeEmail, normalizePhone, renewalHazards, subscriberChurnRisk, subscriptionMonthlyAmount, type SubscriptionInterval } from "@hullwise/core";
import * as schema from "../schema";
import { EN_FIRST, EN_LAST, STREETS_EN, US_CITIES } from "./data";

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Row = Record<string, unknown>;
const DAY = 864e5;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** The replenishment line sold on subscription (Harbor Home): scents per product, price per unit, cost per unit. */
const REFILLS = [
  { key: "CND", title: "Candle Refill", vendor: "Ember & Clay", scents: [["Sea Salt", 40], ["Cedar", 30], ["Fig", 30]] as const, priceBefore: 1800, priceAfter: 1620, cost: 520, share: 0.55 },
  { key: "CLN", title: "Cleaning Concentrate Refill", vendor: "Harbor Workshop", scents: [["Citrus", 40], ["Lavender", 35], ["Unscented", 25]] as const, priceBefore: 2400, priceAfter: 2160, cost: 610, share: 0.45 },
] as const;
/** The variant that will run out before next week's renewals (the demo's stock alert). */
export const SUBSCRIPTION_SHORT_VARIANT = { product: "Candle Refill", scent: "Fig" } as const;

const RAW_REASONS: Record<string, string[]> = {
  too_expensive: ["Too expensive for me right now", "The price is too high", "Can't afford it this month"],
  too_much_product: ["I have too much product", "Too many refills piling up", "I still have plenty left"],
  not_needed: ["Don't need it anymore", "No longer using it"],
  quality: ["Didn't like the scent", "Quality wasn't what I expected"],
  switched: ["Switched to another brand", "Found it cheaper elsewhere"],
  delivery: ["Deliveries keep arriving late", "Shipping problems"],
  moving: ["Moving house", "Travelling for a few months"],
  other: ["", "Other reasons"],
};
const REASONS_BEFORE: [string, number][] = [["too_expensive", 36], ["too_much_product", 20], ["not_needed", 12], ["quality", 8], ["switched", 10], ["delivery", 5], ["moving", 4], ["other", 5]];
const REASONS_AFTER: [string, number][] = [["too_expensive", 12], ["too_much_product", 32], ["not_needed", 16], ["quality", 9], ["switched", 9], ["delivery", 8], ["moving", 7], ["other", 7]];
const ERRORS: [string, number][] = [["card_expired", 45], ["insufficient_funds", 40], ["card_declined", 15]];
const ERROR_TEXT: Record<string, string> = { card_expired: "Your card has expired.", insufficient_funds: "Your card has insufficient funds.", card_declined: "Your card was declined." };

/**
 * `addon.subscriptions` demo data (#67), for tenants with the add-on: a replenishment line (candle and
 * cleaning refills) sold through the simulated Shopify Subscriptions app. ~400 subscribers over 12
 * months (scaled), voluntary churn that improves for cohorts after the subscription price was cut 6
 * months ago, failed renewals partly recovered by the app's retries (the rest churn involuntarily),
 * a few failing right now, pauses and skips, the orders every charge created (flagged as
 * subscription orders) and one variant that runs out before next week's renewals. Own RNG: the rest
 * of the demo data is untouched; runs after every other step.
 */
export async function seedSubscriptions(db: Db, input: { tenantId: string; addons: readonly string[]; now: Date; scale: number; careUserId: string | null; ownerUserId: string | null }): Promise<void> {
  if (!input.addons.includes("addon.subscriptions")) return;
  const { tenantId, now } = input;
  const rng = createRng(20261067);
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) return;
  const [location] = await db.select().from(schema.locations).where(and(eq(schema.locations.tenantId, tenantId), eq(schema.locations.isDefault, true))).limit(1);
  const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.tenantId, tenantId)).orderBy(schema.suppliers.name).limit(1);

  /* catalog: two refill products, three scents each */
  let extSeq = 0;
  const ext = (base: number) => String(base + ++extSeq);
  const variants: { id: string; productId: string; externalId: string; productExternalId: string; title: string; productTitle: string; refill: (typeof REFILLS)[number]; weight: number }[] = [];
  for (const r of REFILLS) {
    const productId = rng.uuid();
    const pExt = ext(8_800_000_000);
    await db.insert(schema.products).values({ id: productId, tenantId, externalId: pExt, title: r.title, handle: r.title.toLowerCase().replace(/\s+/g, "-"), vendor: r.vendor, productType: "Refills", status: "active", tags: ["refill", "subscription"], options: [{ name: "Scent", values: r.scents.map((s) => s[0]) }], imageUrl: null, isAncillary: false, isRepurchasable: true, platformCreatedAt: addDays(now, -400), syncedAt: now });
    for (const [i, [scent, weight]] of r.scents.entries()) {
      const id = rng.uuid();
      const vExt = ext(8_810_000_000);
      await db.insert(schema.productVariants).values({ id, tenantId, productId, externalId: vExt, inventoryItemExternalId: ext(8_820_000_000), sku: `REF-${r.key}-${scent.replace(/\s+/g, "").slice(0, 3).toUpperCase()}`, barcode: String(8_100_000_000_000 + extSeq), title: scent, optionValues: { Scent: scent }, priceMinor: r.priceBefore, compareAtMinor: null, costMinor: r.cost, averageCostMinor: r.cost, weightGrams: 450 + i * 20, packSize: 12, isActive: true, syncedAt: now });
      variants.push({ id, productId, externalId: vExt, productExternalId: pExt, title: scent, productTitle: r.title, refill: r, weight });
      if (supplier) await db.insert(schema.supplierVariants).values({ tenantId, supplierId: supplier.id, variantId: id, supplierSku: `HW-${r.key}-${i + 1}`, unitCostMinor: r.cost, moq: 24, orderMultiple: 12, leadTimeDays: 10, isPrimary: true }).onConflictDoNothing();
    }
  }
  // the selling price is the subscription price after the cut (one-off buyers pay the same on the store)
  for (const v of variants) await db.update(schema.productVariants).set({ priceMinor: v.refill.priceAfter }).where(eq(schema.productVariants.id, v.id));

  /* subscribers: existing customers first, new ones for the rest */
  const target = Math.max(40, Math.round(400 * input.scale));
  const existing = await db.select().from(schema.customers).where(eq(schema.customers.tenantId, tenantId)).orderBy(schema.customers.externalId);
  const reuse = rng.shuffle(existing).slice(0, Math.min(Math.floor(existing.length * 0.5), Math.floor(target * 0.55)));
  const people: (typeof schema.customers.$inferSelect)[] = [...reuse];
  const fresh: Row[] = [];
  for (let i = people.length; i < target; i++) {
    const first = rng.pick(EN_FIRST);
    const last = rng.pick(EN_LAST);
    const city = rng.pick(US_CITIES);
    const phone = `+1 ${rng.int(201, 989)} 555 ${String(rng.int(1000, 9999))}`;
    const email = `${first}.${last}.${i}@example.com`.toLowerCase();
    const row = { id: rng.uuid(), tenantId, externalId: String(9_100_000_000 + i), email, emailNormalized: normalizeEmail(email), phone, phoneE164: normalizePhone(phone, "US"), firstName: first, lastName: last, country: "US", city: city.city, zip: city.zip, acceptsMarketing: rng.chance(0.7), tags: ["subscriber"], ordersCount: 0, totalSpentMinor: 0, platformCreatedAt: addDays(now, -rng.int(5, 380)), syncedAt: now };
    fresh.push(row);
    people.push(row as unknown as typeof schema.customers.$inferSelect);
  }
  for (let i = 0; i < fresh.length; i += 500) await db.insert(schema.customers).values(fresh.slice(i, i + 500) as (typeof schema.customers.$inferInsert)[]);

  /* cancellation reasons (the tenant's editable list) */
  await db.insert(schema.subscriptionCancellationReasons).values(DEFAULT_CANCELLATION_REASONS.map((r, i) => ({ tenantId, code: r.code, label: r.label, kind: r.kind, keywords: [...r.keywords], position: i }))).onConflictDoNothing();

  /* campaigns for the first orders' attribution */
  const campaigns = await db.select({ id: schema.campaigns.id, externalId: schema.campaigns.externalId, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, tenantId)).orderBy(schema.campaigns.externalId);
  const meta = campaigns.filter((c) => c.platform === "meta");
  const google = campaigns.filter((c) => c.platform === "google");

  const [maxRow] = (await db.execute<{ n: number | null }>(sql`select max(order_number)::int as n from orders where tenant_id = ${tenantId}`)).rows;
  let orderNumber = (maxRow?.n ?? 1000) + 1000;
  const priceCutAt = addDays(now, -182);
  const contracts: Row[] = [];
  const lines: Row[] = [];
  const attempts: Row[] = [];
  const events: Row[] = [];
  const orders: Row[] = [];
  const orderLines: Row[] = [];
  const attribution: Row[] = [];
  const orderEvents: Row[] = [];
  const shipments: Row[] = [];
  let attemptSeq = 0;
  interface Gen { id: string; externalId: string; variant: (typeof variants)[number]; quantity: number; unit: SubscriptionInterval; count: number; price: number; status: string; next: Date | null; customer: (typeof people)[number]; renewals: number; lineExternalId: string }
  const gens: Gen[] = [];

  const makeOrder = (g: Gen, at: Date, renewal: number, channel: { channel: string; campaign: (typeof campaigns)[number] | null } | null): string => {
    const id = rng.uuid();
    const n = orderNumber++;
    const c = g.customer;
    const total = g.price;
    const ageDays = (now.getTime() - at.getTime()) / DAY;
    const returned = renewal > 0 && rng.chance(0.015) && ageDays > 20;
    const status = returned ? "returned" : ageDays > 6 ? "delivered" : ageDays > 2 ? "shipped" : "confirmed";
    const fulfilledAt = status === "confirmed" ? null : addDays(at, 1);
    const deliveredAt = status === "delivered" || returned ? addDays(at, 4) : null;
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
    const address = { name, address1: `${rng.int(1, 150)} ${rng.pick(STREETS_EN)}`, city: c.city, zip: c.zip, country: c.country ?? "US", phone: c.phone };
    const landing = channel?.campaign ? `/products/${g.variant.productTitle.toLowerCase().replace(/\s+/g, "-")}?utm_source=${channel.campaign.platform === "meta" ? "facebook" : "google"}&utm_medium=${channel.campaign.platform === "meta" ? "paid" : "cpc"}&utm_campaign=${channel.campaign.externalId}` : "/";
    orders.push({ id, tenantId, externalId: String(7_000_000_000 + n), orderNumber: n, name: `#${tenant.orderNumberPrefix}${n}`, customerId: c.id, customerName: name, email: c.email, emailNormalized: normalizeEmail(c.email), phone: c.phone, phoneE164: c.phoneE164, status, statusSource: "rules", statusReason: null, statusChangedAt: deliveredAt ?? fulfilledAt ?? at, paymentMethod: "card", paymentStatus: returned ? "refunded" : "paid", paymentGateways: ["shopify_payments"], financialStatusRaw: returned ? "refunded" : "paid", fulfillmentStatusRaw: fulfilledAt ? "fulfilled" : null, platformTags: [], currency: tenant.currency, subtotalMinor: total, discountMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: total, refundedMinor: returned ? total : 0, returnedFraction: returned ? 10_000 : 0, shippingAddress: address, billingAddress: address, shippingCountry: address.country, shippingZip: c.zip, shippingCity: c.city, addressKey: addressKey(address), nameZipKey: nameZipKey(name, c.zip), noteAttributes: [], landingSite: renewal === 0 ? landing : null, sourceChannel: renewal === 0 ? "web" : "api", isTest: false, placedAt: at, closedAt: deliveredAt, platformUpdatedAt: deliveredAt ?? fulfilledAt ?? at, syncedAt: now, subscriptionContractId: g.id, isFirstSubscriptionOrder: renewal === 0, renewalNumber: renewal });
    orderLines.push({ id: rng.uuid(), tenantId, orderId: id, externalId: `${7_000_000_000 + n}-1`, productId: g.variant.productId, variantId: g.variant.id, sku: null, title: g.variant.productTitle, variantTitle: g.variant.title, quantity: g.quantity, currentQuantity: g.quantity, unitPriceMinor: Math.round(g.price / g.quantity), discountMinor: 0, totalMinor: g.price, unitCostMinor: g.variant.refill.cost, isAncillary: false });
    const ch = renewal === 0 ? (channel ?? { channel: "direct", campaign: null }) : { channel: "direct", campaign: null };
    attribution.push({ tenantId, orderId: id, utmSource: ch.campaign ? (ch.campaign.platform === "meta" ? "facebook" : "google") : ch.channel === "email" ? "newsletter" : null, utmMedium: ch.campaign ? (ch.campaign.platform === "meta" ? "paid" : "cpc") : ch.channel === "email" ? "email" : null, utmCampaign: ch.campaign?.externalId ?? null, utmContent: null, utmTerm: null, clickIds: {}, campaignId: ch.campaign?.id ?? null, channel: ch.channel, source: "seed", capturedAt: at });
    orderEvents.push({ tenantId, orderId: id, type: "imported", actorType: "integration", diff: {}, metadata: { source: "shopify", subscription: true }, createdAt: at });
    if (fulfilledAt) shipments.push({ id: rng.uuid(), tenantId, orderId: id, externalId: `sub-shp-${n}`, trackingNumber: `1Z${rng.int(100000000, 999999999)}US`, trackingUrl: null, carrier: rng.pick(["UPS", "USPS", "FedEx"]), status: deliveredAt ? "delivered" : "in_transit", sourceOfTruth: "shopify", isLocked: false, shippedAt: fulfilledAt, deliveredAt, estimatedDelivery: addDays(at, 4), lastEventAt: deliveredAt ?? fulfilledAt });
    return id;
  };
  const attempt = (g: Gen, cycle: Date, at: Date, status: "success" | "failed", orderId: string | null, errorCode: string | null, nextRetryAt: Date | null) => {
    attempts.push({ tenantId, contractId: g.id, externalId: `mock-attempt-${g.externalId}-${++attemptSeq}`, status, errorCode, errorMessage: errorCode ? ERROR_TEXT[errorCode] : null, amountMinor: g.price, currency: tenant.currency, orderId, orderExternalId: orderId ? (orders.find((o) => o.id === orderId)?.externalId as string) : null, attemptedAt: at, nextRetryAt, cycleKey: cycle.toISOString().slice(0, 10) });
    if (status === "failed") events.push({ tenantId, contractId: g.id, type: "payment_failed", authorType: "provider", diff: {}, metadata: { source: "seed", errorCode, amountMinor: g.price, nextRetryAt: nextRetryAt?.toISOString() ?? null, cycle: cycle.toISOString().slice(0, 10) }, occurredAt: at });
  };

  for (let i = 0; i < target; i++) {
    const customer = people[i]!;
    const daysAgo = Math.max(2, Math.round(360 * (1 - Math.sqrt(rng.next()))));
    const activatedAt = new Date(addDays(now, -daysAgo).getTime() - rng.int(0, 600) * 60_000);
    const refill = rng.chance(REFILLS[0].share) ? REFILLS[0] : REFILLS[1];
    const scent = rng.weighted(refill.scents.map(([s, w]) => [s, w] as const));
    const variant = variants.find((v) => v.refill === refill && v.title === scent)!;
    const [unit, count] = rng.weighted([[["month", 1], 70], [["month", 2], 20], [["week", 6], 10]] as const) as readonly [SubscriptionInterval, number];
    const quantity = rng.chance(0.75) ? 1 : 2;
    const after = activatedAt.getTime() >= priceCutAt.getTime();
    const price = (after ? refill.priceAfter : refill.priceBefore) * quantity;
    const g: Gen = { id: rng.uuid(), externalId: String(5_550_000_000 + i), variant, quantity, unit, count, price, status: "active", next: null, customer, renewals: 0, lineExternalId: String(6_100_000_000 + i) };
    gens.push(g);
    const roll = rng.next();
    const ch = roll < 0.35 && meta.length ? { channel: "paid_social", campaign: rng.pick(meta) } : roll < 0.5 && google.length ? { channel: "paid_search", campaign: rng.pick(google) } : roll < 0.7 ? { channel: "organic_search", campaign: null } : roll < 0.85 ? { channel: "email", campaign: null } : { channel: "direct", campaign: null };
    const originOrderId = makeOrder(g, activatedAt, 0, ch);
    attempt(g, activatedAt, activatedAt, "success", originOrderId, null, null);
    events.push({ tenantId, contractId: g.id, type: "created", authorType: "customer", diff: {}, metadata: { source: "seed", mrrMinor: subscriptionMonthlyAmount(price, unit, count), priceMinor: price }, occurredAt: activatedAt });
    let d = activatedAt;
    let renewal = 0;
    let pausedAt: Date | null = null;
    let endedAt: Date | null = null;
    let endKind: string | null = null;
    let reasonRaw: string | null = null;
    let failingSince: Date | null = null;
    let skips = 0;
    const hazard = after ? 0.045 : 0.085;
    for (let guard = 0; guard < 80; guard++) {
      const next = addSubscriptionInterval(d, unit, count);
      if (next.getTime() > now.getTime()) { g.next = next; break; }
      if (rng.chance(0.035)) {
        // the customer pauses for 1–3 cycles from the portal
        const from = addDays(next, -2);
        let resume = next;
        for (let k = rng.int(1, 3); k > 0; k--) resume = addSubscriptionInterval(resume, unit, count);
        events.push({ tenantId, contractId: g.id, type: "paused", authorType: "customer", diff: { status: { from: "active", to: "paused" } }, metadata: { source: "seed" }, occurredAt: from });
        if (resume.getTime() > now.getTime()) { g.status = "paused"; pausedAt = from; g.next = resume; break; }
        events.push({ tenantId, contractId: g.id, type: "resumed", authorType: "customer", diff: { status: { from: "paused", to: "active" } }, metadata: { source: "seed" }, occurredAt: addDays(resume, -1) });
        d = addDays(resume, 0);
        const order = makeOrder(g, resume, ++renewal, null);
        attempt(g, resume, resume, "success", order, null, null);
        continue;
      }
      if (rng.chance(0.04)) {
        skips++;
        events.push({ tenantId, contractId: g.id, type: "skipped", authorType: "customer", diff: { nextBillingAt: { from: next.toISOString().slice(0, 10), to: addSubscriptionInterval(next, unit, count).toISOString().slice(0, 10) } }, metadata: { source: "seed" }, occurredAt: addDays(next, -3) });
        d = next;
        continue;
      }
      if (rng.chance(renewal === 0 ? hazard * 1.6 : hazard)) {
        const code = rng.weighted((after ? REASONS_AFTER : REASONS_BEFORE).map(([c, w]) => [c, w] as const));
        reasonRaw = rng.pick(RAW_REASONS[code]!) || null;
        endedAt = addDays(next, -rng.int(1, 9));
        endKind = "voluntary";
        g.status = "cancelled";
        break;
      }
      if (!rng.chance(0.085)) {
        const order = makeOrder(g, next, ++renewal, null);
        attempt(g, next, next, "success", order, null, null);
        d = next;
        continue;
      }
      // a declined renewal: the app retries after 3 and 7 days, then gives up
      const error = rng.weighted(ERRORS.map(([c, w]) => [c, w] as const));
      const r1 = addDays(next, 3);
      const r2 = addDays(next, 7);
      attempt(g, next, next, "failed", null, error, r1);
      if (r1.getTime() > now.getTime()) { failingSince = next; g.next = next; break; }
      if (rng.chance(0.45)) {
        const order = makeOrder(g, r1, ++renewal, null);
        attempt(g, next, r1, "success", order, null, null);
        events.push({ tenantId, contractId: g.id, type: "payment_recovered", authorType: "provider", diff: {}, metadata: { source: "seed", cycle: next.toISOString().slice(0, 10), amountMinor: price }, occurredAt: r1 });
        d = next;
        continue;
      }
      attempt(g, next, r1, "failed", null, error, r2);
      if (r2.getTime() > now.getTime()) { failingSince = next; g.next = next; break; }
      if (rng.chance(0.3)) {
        const order = makeOrder(g, r2, ++renewal, null);
        attempt(g, next, r2, "success", order, null, null);
        events.push({ tenantId, contractId: g.id, type: "payment_recovered", authorType: "provider", diff: {}, metadata: { source: "seed", cycle: next.toISOString().slice(0, 10), amountMinor: price }, occurredAt: r2 });
        d = next;
        continue;
      }
      attempt(g, next, r2, "failed", null, error, null);
      if (addDays(r2, 1).getTime() > now.getTime()) { failingSince = next; g.next = next; break; }
      endedAt = addDays(r2, 1);
      endKind = "involuntary";
      reasonRaw = "Payment failed after the maximum number of retries";
      g.status = "cancelled";
      break;
    }
    g.renewals = renewal;
    if (endedAt) events.push({ tenantId, contractId: g.id, type: "cancelled", authorType: endKind === "involuntary" ? "system" : "customer", diff: { status: { from: "active", to: "cancelled" } }, metadata: { source: "seed", reason: normalizeCancellationReason(reasonRaw, DEFAULT_CANCELLATION_REASONS, { involuntary: endKind === "involuntary" }), raw: reasonRaw }, occurredAt: endedAt });
    contracts.push({ id: g.id, tenantId, provider: "shopify_subscriptions", externalId: g.externalId, customerId: customer.id, status: g.status, currency: tenant.currency, priceMinor: price, mrrMinor: subscriptionMonthlyAmount(price, unit, count), intervalUnit: unit, intervalCount: count, nextBillingAt: g.status === "cancelled" ? null : g.next, activatedAt, pausedAt, endedAt, cancellationKind: endKind, cancellationReasonCode: endedAt ? normalizeCancellationReason(reasonRaw, DEFAULT_CANCELLATION_REASONS, { involuntary: endKind === "involuntary" }) : null, cancellationReasonRaw: endedAt ? reasonRaw : null, discounts: after ? [{ code: null, title: "Subscribe & save 10%", amountMinor: Math.round(price / 9) }] : [], originOrderId, originOrderExternalId: orders.find((o) => o.id === originOrderId)!.externalId, renewalsCount: renewal, skipsCount: skips, paymentFailingSince: failingSince, platformUpdatedAt: endedAt ?? pausedAt ?? (failingSince ? now : activatedAt), syncedAt: addDays(now, 0), createdAt: activatedAt });
    lines.push({ tenantId, contractId: g.id, externalId: g.lineExternalId, productId: variant.productId, variantId: variant.id, variantExternalId: variant.externalId, sku: null, title: variant.productTitle, variantTitle: variant.title, quantity, unitPriceMinor: Math.round(price / quantity) });
  }

  /* a few renewals failing right now (the recovery queue), followed up by customer care */
  const activeGens = gens.filter((g) => g.status === "active" && !(contracts.find((c) => c.id === g.id)!.paymentFailingSince));
  const wanted = Math.min(activeGens.length, Math.max(4, Math.round(activeGens.length * 0.04)));
  const stride = Math.max(1, Math.floor(activeGens.length / Math.max(1, wanted)));
  const forced = activeGens.filter((_, i) => i % stride === Math.min(2, stride - 1)).slice(0, wanted);
  for (const [k, g] of forced.entries()) {
    const c = contracts.find((x) => x.id === g.id)!;
    const due = addDays(now, -(1 + (k % 5)));
    const error = ERRORS[k % ERRORS.length]![0];
    attempt(g, due, due, "failed", null, error, addDays(due, 3));
    if (k % 3 === 0) attempt(g, due, addDays(due, 3), "failed", null, error, addDays(due, 7));
    Object.assign(c, { nextBillingAt: due, paymentFailingSince: due, platformUpdatedAt: due });
    g.next = due;
  }
  const openFailing = contracts.filter((c) => c.paymentFailingSince && c.status === "active");
  for (const [k, c] of openFailing.entries()) {
    if (k % 2 === 1 || !input.careUserId) continue;
    const at = addDays(c.paymentFailingSince as Date, 1);
    if (at.getTime() > now.getTime()) continue;
    Object.assign(c, { assignedTo: input.careUserId, lastContactAt: at });
    events.push({ tenantId, contractId: c.id, type: "assigned", authorType: "staff", actorUserId: input.ownerUserId, diff: { assignedTo: { from: null, to: input.careUserId } }, metadata: {}, occurredAt: addDays(at, -0.1) });
    events.push({ tenantId, contractId: c.id, type: "payment_link_sent", authorType: "staff", actorUserId: input.careUserId, diff: {}, metadata: { provider: "shopify_subscriptions" }, occurredAt: at });
    events.push({ tenantId, contractId: c.id, type: "note", authorType: "staff", actorUserId: input.careUserId, diff: {}, metadata: { body: "Emailed the customer the payment update link; they said they'd update the card this week.", contacted: true }, occurredAt: addDays(at, 0.01) });
  }

  /* the short variant: enough of its renewals next week to outrun the stock (a PO arrives too late) */
  const short = variants.find((v) => v.productTitle === SUBSCRIPTION_SHORT_VARIANT.product && v.title === SUBSCRIPTION_SHORT_VARIANT.scent)!;
  const shortActive = gens.filter((g) => g.variant.id === short.id && g.status === "active" && g.next && !openFailing.some((c) => c.id === g.id));
  const inWeek = (g: Gen) => g.next!.getTime() > now.getTime() && g.next!.getTime() < addDays(now, 7).getTime();
  for (const [k, g] of shortActive.filter((x) => !inWeek(x)).slice(0, Math.max(0, 8 - shortActive.filter(inWeek).length)).entries()) {
    g.next = new Date(addDays(now, 1 + (k % 6)).getTime() + 9 * 3600e3);
    contracts.find((c) => c.id === g.id)!.nextBillingAt = g.next;
  }

  /* write */
  const chunk = async <T extends Row>(rows: T[], insert: (part: T[]) => Promise<unknown>, size = 800) => {
    for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
  };
  await chunk(orders, (p) => db.insert(schema.orders).values(p as (typeof schema.orders.$inferInsert)[]));
  await chunk(orderLines, (p) => db.insert(schema.orderLines).values(p as (typeof schema.orderLines.$inferInsert)[]));
  await chunk(attribution, (p) => db.insert(schema.orderAttribution).values(p as (typeof schema.orderAttribution.$inferInsert)[]));
  await chunk(orderEvents, (p) => db.insert(schema.orderEvents).values(p as (typeof schema.orderEvents.$inferInsert)[]));
  await chunk(shipments, (p) => db.insert(schema.shipments).values(p as (typeof schema.shipments.$inferInsert)[]));
  await chunk(contracts, (p) => db.insert(schema.subscriptionContracts).values(p as (typeof schema.subscriptionContracts.$inferInsert)[]));
  await chunk(lines, (p) => db.insert(schema.subscriptionContractLines).values(p as (typeof schema.subscriptionContractLines.$inferInsert)[]));
  await chunk(attempts, (p) => db.insert(schema.subscriptionBillingAttempts).values(p as (typeof schema.subscriptionBillingAttempts.$inferInsert)[]));
  await chunk(events, (p) => db.insert(schema.subscriptionEvents).values(p as (typeof schema.subscriptionEvents.$inferInsert)[]));
  // customers' order counters include their subscription orders
  await db.execute(sql`update customers c set orders_count = s.n, total_spent_minor = s.total, first_order_at = s.first, last_order_at = s.last from (select customer_id, count(*)::int as n, sum(total_minor)::int as total, min(placed_at) as first, max(placed_at) as last from orders where tenant_id = ${tenantId} and customer_id is not null group by customer_id) s where c.id = s.customer_id and c.tenant_id = ${tenantId}`);

  /* stock: plenty for every refill except the short one; its PO arrives after next week */
  const until = (weeks: number) => addDays(now, weeks * 7);
  const need = (variantId: string, horizon: Date) => gens.filter((g) => g.variant.id === variantId && g.status === "active" && g.next).reduce((s, g) => {
    let n = 0;
    for (let d = g.next!.getTime() < now.getTime() ? now : g.next!; d.getTime() < horizon.getTime(); d = addSubscriptionInterval(d, g.unit, g.count)) n += g.quantity;
    return s + n;
  }, 0);
  if (location) {
    for (const v of variants) {
      const week = need(v.id, until(1));
      const available = v.id === short.id ? Math.max(1, Math.floor(week / 2)) : need(v.id, until(8)) * 3 + 40;
      await db.insert(schema.inventoryLevels).values({ tenantId, variantId: v.id, locationId: location.id, available, committed: 0, onHand: available, syncedAt: now }).onConflictDoNothing();
    }
    if (supplier) {
      const [po] = await db.insert(schema.purchaseOrders).values({ tenantId, supplierId: supplier.id, number: "PO-REFILL-001", status: "sent", currency: tenant.currency, destinationLocationId: location.id, orderedAt: addDays(now, -3), sentAt: addDays(now, -3), expectedAt: addDays(now, 12), totalMinor: 48 * short.refill.cost, notes: "Refill restock", createdBy: input.ownerUserId }).returning({ id: schema.purchaseOrders.id });
      await db.insert(schema.purchaseOrderLines).values({ tenantId, purchaseOrderId: po!.id, variantId: short.id, quantity: 48, receivedQuantity: 0, unitCostMinor: short.refill.cost });
    }
  }

  /* the app's integration, its health and the last sync */
  await db.insert(schema.integrations).values({ tenantId, provider: "shopify_subscriptions", status: "connected", mode: "mock", externalAccountId: "mock-subscriptions", externalAccountName: `${tenant.name} · Shopify Subscriptions`, config: {}, lastSyncAt: addDays(now, -0.02), lastSuccessAt: addDays(now, -0.02) }).onConflictDoNothing();
  await db.insert(schema.integrationHealth).values({ tenantId, source: "shopify_subscriptions", status: "ok", lastSuccessAt: addDays(now, -0.02), lastAttemptAt: addDays(now, -0.02), rowsWrittenLast: 14, freshnessMinutes: 24 * 60 }).onConflictDoNothing();
  await db.insert(schema.syncRuns).values({ tenantId, provider: "shopify_subscriptions", objectType: "subscriptions", kind: "delta", status: "success", rowsScanned: contracts.length, rowsWritten: 14, durationMs: 2300, summary: { contracts: contracts.length, attempts: attempts.length }, startedAt: addDays(now, -0.02), finishedAt: addDays(now, -0.02) });

  /* churn risk: the CRM predictions plus the subscription signals (what the add-on's job computes) */
  const preds = await db.select({ customerId: schema.customerPredictions.customerId, pAlive: schema.customerPredictions.pAlive }).from(schema.customerPredictions).where(eq(schema.customerPredictions.tenantId, tenantId));
  const pAlive = new Map(preds.map((p) => [p.customerId, Number(p.pAlive)]));
  const hazards = renewalHazards(contracts.map((c) => ({ renewals: c.renewalsCount as number, ended: c.endedAt !== null })));
  const recentSkips = new Map<string, number>();
  for (const e of events) if (e.type === "skipped" && (e.occurredAt as Date).getTime() > addDays(now, -90).getTime()) recentSkips.set(e.contractId as string, (recentSkips.get(e.contractId as string) ?? 0) + 1);
  for (const c of contracts) {
    if (c.status !== "active" && c.status !== "paused") continue;
    const risk = subscriberChurnRisk({ status: c.status as string, pAlive: pAlive.get(c.customerId as string) ?? null, paymentFailing: Boolean(c.paymentFailingSince), skipsLast90: recentSkips.get(c.id as string) ?? 0, pausedDays: c.pausedAt ? Math.floor((now.getTime() - (c.pausedAt as Date).getTime()) / DAY) : null, renewals: c.renewalsCount as number, hazardNext: hazards[Math.min(hazards.length - 1, c.renewalsCount as number)] ?? null, frequencyLengthened: false });
    await db.update(schema.subscriptionContracts).set({ churnRisk: risk.risk, churnRetentionBps: Math.round(risk.retention * 10_000), churnFactors: risk.factors, churnComputedAt: now }).where(eq(schema.subscriptionContracts.id, c.id as string));
  }
}
