import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, recordAudit, schema, sql, type Database, type DbExecutor } from "@keel/db";
import { DEFAULT_PAYMENT_TERMS_DAYS, MODULES, PLANS, PLAN_KEYS, UPCOMING_RENEWAL_DAYS, isAddonModule, type PlanKey } from "@keel/config";
import { billingCatalog, catalogItemFor, desiredSubscriptionKeys, lookupKeyFor, mirroredMrr, monthlyChargeMinor, paymentHealth, subscriptionSignal, tablePdf, vatTreatment, type PaymentHealth, type VatTreatment } from "@keel/core";
import {
  BillingProviderError,
  parseMockPriceId,
  parseStripeEvent,
  stripeCheckoutObject,
  stripeEvent,
  stripeInvoiceObject,
  stripeSubscriptionObject,
  toCheckoutSnapshot,
  toCustomerSnapshot,
  toInvoiceSnapshot,
  toSubscriptionSnapshot,
  verifyStripeSignature,
  type BillingProvider,
  type InvoicingProvider,
  type StripeEvent,
  type StripeSignatureCheck,
} from "@keel/integrations";
import type { ServiceContext } from "../context";
import { queueEmail } from "../email/mailer";
import { transitionTenant } from "./lifecycle";
import { applySubscriptionSnapshot, BillingError, lockTenantBilling, priceIdFor, upsertInvoiceSnapshot, type InvoiceFlag } from "./mirror";
import { refreshTenantPaymentState, tenantPaymentStatus } from "./payment-state";
import { setTenantAddon, setTenantPlan } from "./plan";
import { billingSettings, getBillingProvider, getInvoicingProvider, type BillingSettings } from "./provider";

/**
 * Stripe billing for Keel's customers (#53). Stripe subscriptions are the source of truth for
 * collection: card on file, automatic charges, Smart Retries, dunning emails, proration. Keel
 * keeps the catalog (@keel/config), decides entitlements and the tenant lifecycle, and mirrors
 * subscriptions and invoices from webhooks. Everything here runs on the admin connection except
 * the owner's billing page and portal, which read through the tenant transaction (RLS).
 */

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const audit = (db: DbExecutor, actorUserId: string | null, tenantId: string | null, action: string, extra: { entityType?: string; entityId?: string; diff?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}) => recordAudit(db, { tenantId, actorUserId, actorType: actorUserId ? "super_admin" : "system", action, ...extra });

/* ---------- catalog ---------- */

export interface CatalogSyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
}

/** Creates or updates the Stripe product and price of every plan, setup fee and add-on. Idempotent: a second run changes nothing. */
export async function syncBillingCatalog(db: Database, opts: { provider?: BillingProvider; actorUserId: string | null; now?: Date }): Promise<CatalogSyncSummary> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? getBillingProvider();
  const catalog = billingCatalog();
  let results;
  try {
    results = await provider.syncCatalog(catalog);
  } catch (e) {
    if (e instanceof BillingProviderError) throw new BillingError("provider_failed");
    throw e;
  }
  const rows = await db.select().from(schema.billingPrices).where(eq(schema.billingPrices.provider, provider.provider));
  const summary: CatalogSyncSummary = { created: 0, updated: 0, unchanged: 0, archived: 0 };
  for (const r of results) {
    const item = catalog.find((c) => c.lookupKey === r.lookupKey)!;
    const row = rows.find((x) => x.lookupKey === r.lookupKey);
    // the mock reports "unchanged" for everything: the mirror tells what is new
    const outcome = !row || row.priceId !== r.priceId ? "created" : r.outcome;
    summary[outcome]++;
    if (r.archivedPriceId) summary.archived++;
    const values = { provider: provider.provider, lookupKey: r.lookupKey, kind: item.kind, itemKey: item.key, productId: r.productId, priceId: r.priceId, amountMinor: r.amountMinor, currency: r.currency, interval: r.interval, syncedAt: now };
    if (row) await db.update(schema.billingPrices).set(values).where(eq(schema.billingPrices.id, row.id));
    else await db.insert(schema.billingPrices).values(values);
  }
  await audit(db, opts.actorUserId, null, "billing.catalog_synced", { metadata: { provider: provider.provider, mode: provider.mode, ...summary } });
  return summary;
}

export interface CatalogRow {
  lookupKey: string;
  kind: string;
  key: string;
  name: string;
  amountMinor: number;
  currency: string;
  interval: string | null;
  priceId: string | null;
  syncedAt: Date | null;
  /** The last sync has this amount: nothing to push. */
  inStep: boolean;
}

export async function billingCatalogState(db: DbExecutor, providerName = getBillingProvider().provider): Promise<CatalogRow[]> {
  const rows = await db.select().from(schema.billingPrices).where(eq(schema.billingPrices.provider, providerName));
  return billingCatalog().map((c) => {
    const row = rows.find((r) => r.lookupKey === c.lookupKey);
    return { lookupKey: c.lookupKey, kind: c.kind, key: c.key, name: c.name, amountMinor: c.amountMinor, currency: c.currency, interval: c.interval, priceId: row?.priceId ?? null, syncedAt: row?.syncedAt ?? null, inStep: Boolean(row && row.amountMinor === c.amountMinor && row.currency === c.currency) };
  });
}

/* ---------- starting a subscription ---------- */

export interface StartSubscriptionInput {
  planKey: PlanKey;
  addons: string[];
  chargeSetupFee: boolean;
  trialDays: number;
  billingEmail: string;
  /** checkout: card on file through Stripe Checkout · invoice: bank transfer, Stripe emails each invoice with payment terms. */
  collection: "checkout" | "invoice";
  paymentTermsDays?: number;
}

export type StartSubscriptionResult = { kind: "checkout"; url: string; expiresAt: Date | null; sessionId: string; email: "queued" | "suppressed" | "duplicate" | "invalid" } | { kind: "invoice"; subscriptionId: string };

/**
 * Console "Start subscription": applies the chosen plan and add-ons to the tenant, then opens a
 * Stripe Checkout session (subscription mode, the setup fee as a one-off line of the first invoice)
 * and emails its link to the billing contact in the tenant's language; or, for bank-transfer
 * customers, creates a `send_invoice` subscription with payment terms. Audited.
 */
export async function startSubscription(db: Database, tenantId: string, input: StartSubscriptionInput, opts: { provider?: BillingProvider; actorUserId: string; appUrl: string; now?: Date; settings?: BillingSettings }): Promise<StartSubscriptionResult> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? getBillingProvider();
  const settings = opts.settings ?? billingSettings();
  if (!PLAN_KEYS.includes(input.planKey) || input.trialDays < 0 || input.trialDays > 365 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.billingEmail.trim())) throw new BillingError("invalid_input");
  const addons = [...new Set(input.addons)].filter((a) => isAddonModule(a) && MODULES[a].availability === "implemented");
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new BillingError("tenant_not_found");
  const [existing] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (existing?.externalSubscriptionId && !["canceled", "incomplete_expired"].includes(existing.externalStatus ?? "")) throw new BillingError("already_subscribed");
  // the mock catalog fills itself on first use (no processor involved); Stripe's is synced from the console
  if (provider.provider === "mock" && !(await db.select({ id: schema.billingPrices.id }).from(schema.billingPrices).where(eq(schema.billingPrices.provider, "mock")).limit(1)).length) await syncBillingCatalog(db, { provider, actorUserId: opts.actorUserId, now });
  // every price must exist before anything changes
  const recurring = await Promise.all(desiredSubscriptionKeys(input.planKey, addons).map((k) => priceIdFor(db, provider.provider, k)));
  const oneOff = input.chargeSetupFee ? [await priceIdFor(db, provider.provider, lookupKeyFor("setup", input.planKey))] : [];
  // entitlements first: the plan and add-ons the customer is buying (each change audited)
  if (tenant.planKey !== input.planKey) await setTenantPlan(db, tenantId, input.planKey, opts.actorUserId, now, { provider });
  const active = (await db.select({ k: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.isActive, true)))).map((r) => r.k);
  for (const a of addons) if (!active.includes(a)) await setTenantAddon(db, tenantId, a, true, opts.actorUserId, "subscription", now, { provider });
  for (const a of active) if (!addons.includes(a) && isAddonModule(a) && MODULES[a].availability === "implemented") await setTenantAddon(db, tenantId, a, false, opts.actorUserId, "subscription", now, { provider });
  const email = input.billingEmail.trim().toLowerCase();
  let customerId: string;
  try {
    customerId = await provider.ensureCustomer({ tenantId, name: tenant.name, email, locale: tenant.defaultLocale });
  } catch (e) {
    if (e instanceof BillingProviderError) throw new BillingError("provider_failed");
    throw e;
  }
  const base = { tenantId, planKey: input.planKey, provider: provider.provider, externalCustomerId: customerId, billingEmail: email, currency: PLANS[input.planKey].currency, collectionMethod: input.collection === "invoice" ? "send_invoice" : "charge_automatically", paymentTermsDays: input.collection === "invoice" ? (input.paymentTermsDays ?? DEFAULT_PAYMENT_TERMS_DAYS) : null, setupFeeMinor: input.chargeSetupFee ? PLANS[input.planKey].setupFeeMinor : 0, updatedAt: now };
  const save = async (extra: Partial<typeof schema.subscriptions.$inferInsert>) => {
    if (existing) await db.update(schema.subscriptions).set({ ...base, ...extra }).where(eq(schema.subscriptions.id, existing.id));
    else await db.insert(schema.subscriptions).values({ ...base, status: tenant.status === "trial" ? "trialing" : "active", currentPeriodStart: now, currentPeriodEnd: now, ...extra });
  };
  const idempotencyKey = `keel-start-${tenantId}-${hash(`${JSON.stringify(input)}|${now.toISOString()}`)}`;
  const start = { customerId, tenantId, priceIds: recurring, oneOffPriceIds: oneOff, trialDays: input.trialDays || null, automaticTax: settings.automaticTax, idempotencyKey };
  try {
    if (input.collection === "invoice") {
      const snap = await provider.createInvoicedSubscription({ ...start, daysUntilDue: base.paymentTermsDays ?? DEFAULT_PAYMENT_TERMS_DAYS });
      await save({});
      await applySubscriptionSnapshot(db, tenantId, snap, { provider: provider.provider, now, actorUserId: opts.actorUserId });
      await audit(db, opts.actorUserId, tenantId, "billing.subscription_started", { entityType: "tenant", entityId: tenantId, metadata: { collection: "invoice", planKey: input.planKey, addons, setupFee: input.chargeSetupFee, trialDays: input.trialDays, paymentTermsDays: base.paymentTermsDays, externalSubscriptionId: snap.id } });
      return { kind: "invoice", subscriptionId: snap.id };
    }
    const billingUrl = `${opts.appUrl.replace(/\/$/, "")}/t/${tenant.slug}/settings/billing`;
    const session = await provider.createCheckoutSession({ ...start, successUrl: `${billingUrl}?checkout=success`, cancelUrl: `${billingUrl}?checkout=cancelled`, locale: tenant.defaultLocale });
    await save({ checkoutSessionId: session.id, checkoutUrl: session.url, checkoutExpiresAt: session.expiresAt, checkoutItems: { priceIds: recurring, oneOffPriceIds: oneOff, trialDays: input.trialDays } });
    const lines = [...desiredSubscriptionKeys(input.planKey, addons), ...(input.chargeSetupFee ? [lookupKeyFor("setup", input.planKey)] : [])].map((k) => catalogItemFor(k)!).map((c) => ({ kind: c.kind, key: c.key, amountMinor: c.amountMinor }));
    const queued = await queueEmail({ db, now }, { to: email, template: "billing_checkout", locale: tenant.defaultLocale, event: session.id, data: { tenantName: tenant.name, planName: input.planKey.charAt(0).toUpperCase() + input.planKey.slice(1), lines, currency: PLANS[input.planKey].currency, trialDays: input.trialDays, url: session.url, expiresAt: session.expiresAt, timezone: tenant.timezone } });
    await audit(db, opts.actorUserId, tenantId, "billing.subscription_started", { entityType: "tenant", entityId: tenantId, metadata: { collection: "checkout", planKey: input.planKey, addons, setupFee: input.chargeSetupFee, trialDays: input.trialDays, checkoutSessionId: session.id, email: queued.outcome } });
    return { kind: "checkout", url: session.url, expiresAt: session.expiresAt, sessionId: session.id, email: queued.outcome };
  } catch (e) {
    if (e instanceof BillingProviderError) throw new BillingError("provider_failed");
    throw e;
  }
}

/* ---------- webhooks ---------- */

export type WebhookReceipt = { ok: true; id: string | null; duplicate: boolean; ignored: boolean } | { ok: false; status: 400; reason: Exclude<StripeSignatureCheck, { ok: true }>["reason"] | "invalid_payload" };

/** Resolves the tenant of a Stripe object: our metadata first, then the customer id we mirror. */
async function resolveTenant(db: DbExecutor, event: StripeEvent): Promise<string | null> {
  const o = event.object;
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const fromMeta = typeof meta.keel_tenant_id === "string" ? meta.keel_tenant_id : event.type.startsWith("invoice.") ? toInvoiceSnapshot(o).subscriptionTenantId : event.type === "checkout.session.completed" ? toCheckoutSnapshot(o).clientReferenceId : null;
  const valid = async (id: string | null) => (id && /^[0-9a-f-]{36}$/i.test(id) && (await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1)).length ? id : null);
  const byMeta = await valid(fromMeta);
  if (byMeta) return byMeta;
  const customer = typeof o.customer === "string" ? o.customer : o.object === "customer" && typeof o.id === "string" ? o.id : null;
  if (!customer) return null;
  const [sub] = await db.select({ tenantId: schema.subscriptions.tenantId }).from(schema.subscriptions).where(eq(schema.subscriptions.externalCustomerId, customer)).limit(1);
  return sub?.tenantId ?? null;
}

/** Stores a verified event once (unique on provider + event id): a redelivery is a no-op. */
export async function recordBillingEvent(db: DbExecutor, input: { provider: "stripe" | "mock"; event: StripeEvent; now?: Date }): Promise<{ id: string | null; duplicate: boolean }> {
  const tenantRef = await resolveTenant(db, input.event);
  const [row] = await db
    .insert(schema.billingEvents)
    .values({ provider: input.provider, eventId: input.event.id.slice(0, 200), type: input.event.type, livemode: input.event.livemode, tenantRef, object: input.event.object, occurredAt: input.event.created, receivedAt: input.now ?? new Date() })
    .onConflictDoNothing()
    .returning({ id: schema.billingEvents.id });
  return { id: row?.id ?? null, duplicate: !row };
}

let lastRejectionAudit = 0;
/**
 * The route's work before the 200: signature (Stripe-Signature, HMAC-SHA256, 5-minute tolerance),
 * payload, mode (a live event on a test key, or the reverse, is ignored), storage. A bad signature
 * is logged (console, and an audit row at most once a minute so a flood cannot fill the log); the
 * secret and the body never are.
 */
export async function receiveStripeWebhook(db: Database, input: { rawBody: string; signature: string | null; secret: string; now?: Date; ip?: string | null; settings?: BillingSettings }): Promise<WebhookReceipt> {
  const now = input.now ?? new Date();
  const check = verifyStripeSignature(input.signature, input.rawBody, input.secret, { now: now.getTime() });
  let event: StripeEvent | null = null;
  if (check.ok) {
    try {
      event = parseStripeEvent(JSON.parse(input.rawBody));
    } catch {
      event = null;
    }
  }
  if (!check.ok || !event) {
    const reason = check.ok ? "invalid_payload" : check.reason;
    console.warn(`[billing] stripe webhook rejected: ${reason}`);
    if (now.getTime() - lastRejectionAudit > 60_000) {
      lastRejectionAudit = now.getTime();
      await recordAudit(db, { tenantId: null, actorType: "system", action: "billing.webhook_rejected", metadata: { reason, bytes: input.rawBody.length }, ip: input.ip ?? null });
    }
    return { ok: false, status: 400, reason };
  }
  const settings = input.settings ?? billingSettings();
  const recorded = await recordBillingEvent(db, { provider: "stripe", event, now });
  if (recorded.id && settings.mode !== "mock" && event.livemode !== (settings.mode === "live")) {
    await db.update(schema.billingEvents).set({ status: "ignored", processedAt: now, lastError: "mode_mismatch" }).where(eq(schema.billingEvents.id, recorded.id));
    return { ok: true, id: recorded.id, duplicate: false, ignored: true };
  }
  return { ok: true, id: recorded.id, duplicate: recorded.duplicate, ignored: false };
}

const HANDLED = new Set(["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.finalized", "invoice.paid", "invoice.payment_failed", "invoice.marked_uncollectible", "invoice.payment_action_required", "invoice.voided", "customer.updated"]);

/** Applies one stored event to the mirror and the lifecycle, in one transaction serialised per tenant. */
export async function processBillingEvent(db: Database, eventRowId: string, opts: { now?: Date; provider?: BillingProvider; invoicing?: InvoicingProvider | null; settings?: BillingSettings } = {}): Promise<"processed" | "ignored" | "failed" | "missing"> {
  const now = opts.now ?? new Date();
  const [ev] = await db.select().from(schema.billingEvents).where(eq(schema.billingEvents.id, eventRowId)).limit(1);
  if (!ev) return "missing";
  if (ev.status === "processed" || ev.status === "ignored") return ev.status;
  const done = (status: "processed" | "ignored" | "failed", lastError: string | null = null, tenantRef = ev.tenantRef) => db.update(schema.billingEvents).set({ status, attempts: ev.attempts + 1, processedAt: status === "failed" ? null : now, lastError, tenantRef }).where(eq(schema.billingEvents.id, ev.id));
  if (!HANDLED.has(ev.type)) {
    await done("ignored", "unhandled_type");
    return "ignored";
  }
  const event: StripeEvent = { id: ev.eventId, type: ev.type, created: ev.occurredAt ?? now, livemode: ev.livemode, object: ev.object };
  const tenantId = ev.tenantRef ?? (await resolveTenant(db, event));
  if (!tenantId) {
    await done("ignored", "unknown_tenant", null);
    return "ignored";
  }
  try {
    await db.transaction(async (tx) => {
      await lockTenantBilling(tx, tenantId);
      await applyEvent(tx, tenantId, event, { provider: ev.provider, now, billingProvider: opts.provider ?? getBillingProvider(), invoicing: opts.invoicing === undefined ? getInvoicingProvider() : opts.invoicing, settings: opts.settings ?? billingSettings() });
    });
    await done("processed", null, tenantId);
    return "processed";
  } catch (e) {
    await done("failed", (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "[link]").slice(0, 300), tenantId);
    return "failed";
  }
}

async function applyEvent(tx: DbExecutor, tenantId: string, event: StripeEvent, opts: { provider: string; now: Date; billingProvider: BillingProvider; invoicing: InvoicingProvider | null; settings: BillingSettings }): Promise<void> {
  const { now } = opts;
  const at = event.created;
  const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (event.type === "checkout.session.completed") {
    const c = toCheckoutSnapshot(event.object);
    if (sub) await tx.update(schema.subscriptions).set({ externalCustomerId: c.customerId ?? sub.externalCustomerId, externalSubscriptionId: sub.externalSubscriptionId ?? c.subscriptionId, provider: opts.provider, checkoutSessionId: null, checkoutUrl: null, checkoutExpiresAt: null, checkoutItems: null, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    await audit(tx, null, tenantId, "billing.checkout_completed", { entityType: "subscription", entityId: sub?.id, metadata: { provider: opts.provider, checkoutSessionId: c.id, externalSubscriptionId: c.subscriptionId, paymentStatus: c.paymentStatus } });
    return;
  }
  if (event.type.startsWith("customer.subscription.")) {
    // out-of-order delivery: an older snapshot never overwrites a newer one
    if (sub?.lastEventAt && at < sub.lastEventAt) return;
    const snap = toSubscriptionSnapshot(event.object);
    await applySubscriptionSnapshot(tx, tenantId, snap, { provider: opts.provider, eventAt: at, now });
    if (event.type === "customer.subscription.deleted") {
      const [tenant] = await tx.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
      // cancelled by the customer: the workspace closes (data kept for the retention window); after failed payments the suspension rule decides
      if (snap.cancellationReason === "cancellation_requested" && tenant && tenant.status !== "churned") await transitionTenant(tx, tenantId, { to: "churned", reason: "customer_request", note: "Stripe subscription cancelled", actorUserId: null, now });
    }
    await refreshTenantPaymentState(tx, tenantId, now, null);
    return;
  }
  if (event.type.startsWith("invoice.")) {
    const inv = toInvoiceSnapshot(event.object);
    if (inv.status === "draft") return;
    const flag: InvoiceFlag = event.type === "invoice.payment_failed" ? "payment_failed" : event.type === "invoice.payment_action_required" ? "action_required" : event.type === "invoice.paid" ? "paid" : null;
    const { row, statusChanged } = await upsertInvoiceSnapshot(tx, tenantId, inv, { provider: opts.provider, flag, eventAt: at, now });
    if (row.status === "paid" && statusChanged && opts.invoicing && !row.einvoiceStatus) await pushEInvoice(tx, tenantId, row, sub ?? null, opts.invoicing);
    await refreshTenantPaymentState(tx, tenantId, now, null);
    return;
  }
  if (event.type === "customer.updated" && sub) {
    const c = toCustomerSnapshot(event.object);
    const before = { billingEmail: sub.billingEmail, customerCountry: sub.customerCountry, taxIds: JSON.stringify(sub.customerTaxIds), taxExempt: sub.taxExempt };
    await tx.update(schema.subscriptions).set({ billingEmail: c.email ?? sub.billingEmail, customerCountry: c.country, customerTaxIds: c.taxIds, taxExempt: c.taxExempt, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    const after = { billingEmail: c.email ?? sub.billingEmail, customerCountry: c.country, taxIds: JSON.stringify(c.taxIds), taxExempt: c.taxExempt };
    const diff = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k as keyof typeof before] !== v).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]));
    if (Object.keys(diff).length) await audit(tx, null, tenantId, "billing.customer_updated", { entityType: "subscription", entityId: sub.id, diff });
    // without Stripe Tax, Keel sets the reverse charge itself from the verified VAT id
    if (!opts.settings.automaticTax && opts.billingProvider.provider === "stripe" && c.id) {
      const treatment = vatTreatment({ sellerCountry: opts.settings.sellerCountry, customerCountry: c.country, vatIdVerified: c.taxIds.some((t) => t.verified && t.type === "eu_vat") });
      const want = treatment === "reverse_charge" ? "reverse" : treatment === "unknown" ? null : "none";
      if (want && want !== c.taxExempt) {
        await opts.billingProvider.setCustomerTaxExempt(c.id, want);
        await audit(tx, null, tenantId, "billing.tax_exempt_set", { entityType: "subscription", entityId: sub.id, diff: { taxExempt: { from: c.taxExempt, to: want } }, metadata: { treatment } });
      }
    }
  }
}

async function pushEInvoice(tx: DbExecutor, tenantId: string, row: typeof schema.invoices.$inferSelect, sub: typeof schema.subscriptions.$inferSelect | null, invoicing: InvoicingProvider): Promise<void> {
  const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  try {
    const r = await invoicing.pushInvoice({ invoiceNumber: row.number, externalInvoiceId: row.externalId ?? row.id, issuedAt: row.issuedAt, currency: row.currency, totalMinor: row.amountMinor, taxMinor: row.taxMinor ?? 0, lines: (row.lines as { kind: string; key: string; amountMinor: number }[]).map((l) => ({ description: catalogItemFor(l.kind === "plan" || l.kind === "setup" || l.kind === "addon" ? lookupKeyFor(l.kind, l.key) : null)?.name ?? l.key, amountMinor: l.amountMinor })), customer: { name: tenant?.name ?? "", country: sub?.customerCountry ?? null, vatId: sub?.customerTaxIds.find((t) => t.verified)?.value ?? null, email: sub?.billingEmail ?? null } });
    await tx.update(schema.invoices).set({ einvoiceStatus: r.status, einvoiceRef: r.externalId }).where(eq(schema.invoices.id, row.id));
  } catch (e) {
    await tx.update(schema.invoices).set({ einvoiceStatus: "failed" }).where(eq(schema.invoices.id, row.id));
    console.warn("[billing] e-invoice push failed:", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

/** Events left pending (the process died after the 200) or failed: processed again, up to five attempts. */
export async function retryBillingEvents(db: Database, now = new Date()): Promise<number> {
  const rows = await db.select({ id: schema.billingEvents.id, attempts: schema.billingEvents.attempts }).from(schema.billingEvents).where(and(inArray(schema.billingEvents.status, ["pending", "failed"]), lt(schema.billingEvents.receivedAt, new Date(now.getTime() - 60_000)))).orderBy(asc(schema.billingEvents.occurredAt)).limit(500);
  let n = 0;
  for (const r of rows) if (r.attempts < 5 && (await processBillingEvent(db, r.id, { now })) === "processed") n++;
  return n;
}

/** Processed and ignored events older than the retention window are deleted (failed ones stay until resolved). */
export async function purgeBillingEvents(db: Database, opts: { days: number; now?: Date }): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.days * 864e5);
  const r = await db.delete(schema.billingEvents).where(and(inArray(schema.billingEvents.status, ["processed", "ignored"]), lt(schema.billingEvents.receivedAt, cutoff))).returning({ id: schema.billingEvents.id });
  return r.length;
}

/* ---------- mock: the webhooks Stripe would send ---------- */

async function ingestMock(db: Database, events: Record<string, unknown>[], now: Date): Promise<number> {
  let processed = 0;
  for (const raw of events) {
    const event = parseStripeEvent(raw)!;
    const rec = await recordBillingEvent(db, { provider: "mock", event, now });
    if (rec.id && (await processBillingEvent(db, rec.id, { now })) === "processed") processed++;
  }
  return processed;
}

async function mockContext(db: Database, tenantId: string) {
  if (getBillingProvider().provider !== "mock") throw new BillingError("not_mock");
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (!sub) throw new BillingError("no_subscription");
  return sub;
}

const mockItems = (priceIds: string[], subId: string) =>
  priceIds.map((p, n) => {
    const m = parseMockPriceId(p);
    return { itemId: `mock_si_${hash(`${subId}:${p}`)}`.slice(0, 32), priceId: p, lookupKey: m?.lookupKey ?? null, unitAmountMinor: m?.amountMinor ?? 0, currency: "usd", interval: "month" as const, quantity: 1, n };
  });

/** Mock mode: the customer completed the pending Checkout. Same events and processing as Stripe. Re-running is a no-op (same event ids). */
export async function simulateMockCheckout(db: Database, tenantId: string, opts: { actorUserId: string; now?: Date }): Promise<{ processed: number }> {
  const now = opts.now ?? new Date();
  const sub = await mockContext(db, tenantId);
  if (!sub.checkoutSessionId || !sub.checkoutItems) throw new BillingError("no_checkout");
  const cs = sub.checkoutSessionId;
  const subId = `mock_sub_${hash(cs)}`;
  const invId = `mock_in_${hash(`${cs}:1`)}`;
  const customer = sub.externalCustomerId ?? `mock_cus_${tenantId.slice(0, 8)}`;
  const trial = sub.checkoutItems.trialDays;
  const end = new Date(now);
  if (trial) end.setTime(now.getTime() + trial * 864e5);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const items = mockItems(sub.checkoutItems.priceIds, subId);
  const subObj = stripeSubscriptionObject({ id: subId, customerId: customer, tenantId, status: trial ? "trialing" : "active", items, periodStart: now, periodEnd: end, trialEnd: trial ? end : null, latestInvoiceId: invId, paymentMethod: { brand: "visa", last4: "4242" } });
  const lines = [...sub.checkoutItems.priceIds, ...sub.checkoutItems.oneOffPriceIds].map((p) => {
    const m = parseMockPriceId(p);
    const item = catalogItemFor(m?.lookupKey);
    return { priceId: p, description: item?.name ?? p, amountMinor: trial && item?.interval ? 0 : (m?.amountMinor ?? 0) };
  });
  const n = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId)))[0]?.n ?? 0;
  const invoice = (status: string) => stripeInvoiceObject({ id: invId, number: `MOCK-${tenantId.slice(0, 4).toUpperCase()}-${String(n + 1).padStart(4, "0")}`, customerId: customer, subscriptionId: subId, tenantId, status, billingReason: "subscription_create", currency: "usd", lines, created: now, paidAt: status === "paid" ? now : null, attemptCount: status === "paid" ? 1 : 0, periodStart: now, periodEnd: now });
  const ev = (k: number, type: string, object: Record<string, unknown>) => stripeEvent(type, object, { id: `mock_evt_${hash(`${cs}:${k}`)}`, created: now });
  await audit(db, opts.actorUserId, tenantId, "billing.mock_checkout_simulated", { entityType: "subscription", entityId: sub.id, metadata: { checkoutSessionId: cs } });
  return { processed: await ingestMock(db, [ev(1, "checkout.session.completed", stripeCheckoutObject({ id: cs, customerId: customer, subscriptionId: subId, tenantId, status: "complete", paymentStatus: "paid" })), ev(2, "customer.subscription.created", subObj), ev(3, "invoice.finalized", invoice("open")), ev(4, "invoice.paid", invoice("paid"))], now) };
}

/** Mock mode: the period renews; with `fail` the card is declined (past due at once, Smart Retries in 3 days). */
export async function simulateMockRenewal(db: Database, tenantId: string, opts: { actorUserId: string; fail: boolean; now?: Date }): Promise<{ processed: number }> {
  const now = opts.now ?? new Date();
  const sub = await mockContext(db, tenantId);
  if (!sub.externalSubscriptionId) throw new BillingError("not_managed");
  const key = `${sub.externalSubscriptionId}:${now.toISOString().slice(0, 10)}:${opts.fail ? "fail" : "ok"}`;
  const invId = `mock_in_${hash(key)}`;
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const status = opts.fail ? "past_due" : "active";
  const items = sub.items.map((i) => ({ ...i }));
  const n = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId)))[0]?.n ?? 0;
  const lines = items.map((i) => ({ priceId: i.priceId, description: catalogItemFor(i.lookupKey)?.name ?? i.priceId, amountMinor: i.unitAmountMinor * i.quantity }));
  const invoice = (s: string) => stripeInvoiceObject({ id: invId, number: `MOCK-${tenantId.slice(0, 4).toUpperCase()}-${String(n + 1).padStart(4, "0")}`, customerId: sub.externalCustomerId ?? "", subscriptionId: sub.externalSubscriptionId, tenantId, status: s, billingReason: "subscription_cycle", currency: "usd", lines, created: now, paidAt: s === "paid" ? now : null, attemptCount: 1, nextPaymentAttempt: opts.fail ? new Date(now.getTime() + 3 * 864e5) : null, collectionMethod: sub.collectionMethod ?? "charge_automatically" });
  const ev = (k: number, type: string, object: Record<string, unknown>) => stripeEvent(type, object, { id: `mock_evt_${hash(`${key}:${k}`)}`, created: now });
  const subObj = stripeSubscriptionObject({ id: sub.externalSubscriptionId, customerId: sub.externalCustomerId ?? "", tenantId, status, items, periodStart: now, periodEnd: end, collectionMethod: sub.collectionMethod === "send_invoice" ? "send_invoice" : "charge_automatically", latestInvoiceId: invId });
  await audit(db, opts.actorUserId, tenantId, "billing.mock_renewal_simulated", { entityType: "subscription", entityId: sub.id, metadata: { fail: opts.fail } });
  return { processed: await ingestMock(db, [ev(1, "invoice.finalized", invoice("open")), ev(2, opts.fail ? "invoice.payment_failed" : "invoice.paid", invoice(opts.fail ? "open" : "paid")), ev(3, "customer.subscription.updated", subObj)], now) };
}

/** Mock mode: a failed invoice is paid (a retry, or the customer through the payment page). */
export async function simulateMockPayment(db: Database, tenantId: string, opts: { actorUserId: string; now?: Date }): Promise<{ processed: number }> {
  const now = opts.now ?? new Date();
  const sub = await mockContext(db, tenantId);
  const [inv] = await db.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.provider, "mock"), inArray(schema.invoices.status, ["open", "uncollectible"]), isNotNull(schema.invoices.externalId))).orderBy(desc(schema.invoices.issuedAt)).limit(1);
  if (!inv?.externalId || !inv.externalId.startsWith("mock_in_") || !sub.externalSubscriptionId) throw new BillingError("not_managed");
  const lines = (inv.lines as { kind: string; key: string; amountMinor: number }[]).map((l) => ({ priceId: null, description: l.key, amountMinor: l.amountMinor }));
  const key = `${inv.externalId}:paid`;
  const ev = (k: number, type: string, object: Record<string, unknown>) => stripeEvent(type, object, { id: `mock_evt_${hash(`${key}:${k}`)}`, created: now });
  const paid = stripeInvoiceObject({ id: inv.externalId, number: inv.number, customerId: sub.externalCustomerId ?? "", subscriptionId: sub.externalSubscriptionId, tenantId, status: "paid", billingReason: "subscription_cycle", currency: inv.currency, lines, created: inv.issuedAt, paidAt: now, attemptCount: inv.attemptCount + 1, collectionMethod: inv.collectionMethod ?? "charge_automatically" });
  const subObj = stripeSubscriptionObject({ id: sub.externalSubscriptionId, customerId: sub.externalCustomerId ?? "", tenantId, status: "active", items: sub.items, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, collectionMethod: sub.collectionMethod === "send_invoice" ? "send_invoice" : "charge_automatically" });
  await audit(db, opts.actorUserId, tenantId, "billing.mock_payment_simulated", { entityType: "invoice", entityId: inv.id });
  return { processed: await ingestMock(db, [ev(1, "invoice.paid", paid), ev(2, "customer.subscription.updated", subObj)], now) };
}

/* ---------- resync, portal ---------- */

/** "Resync from Stripe" (console): reads the subscription and recent invoices back and applies them. */
export async function resyncTenantBilling(db: Database, tenantId: string, opts: { provider?: BillingProvider; actorUserId: string | null; now?: Date }): Promise<{ subscription: boolean; invoices: number }> {
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? getBillingProvider();
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (!sub?.externalCustomerId) throw new BillingError("no_customer");
  try {
    const snap = sub.externalSubscriptionId ? await provider.fetchSubscription(sub.externalSubscriptionId) : null;
    const invoices = await provider.listInvoices(sub.externalCustomerId, 24);
    let n = 0;
    await db.transaction(async (tx) => {
      await lockTenantBilling(tx, tenantId);
      if (snap) await applySubscriptionSnapshot(tx, tenantId, snap, { provider: provider.provider, now, actorUserId: opts.actorUserId });
      for (const inv of invoices.filter((i) => i.status !== "draft").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
        await upsertInvoiceSnapshot(tx, tenantId, inv, { provider: provider.provider, flag: inv.status === "open" && inv.attemptCount > 0 && inv.collectionMethod === "charge_automatically" ? "payment_failed" : null, now });
        n++;
      }
      await refreshTenantPaymentState(tx, tenantId, now, opts.actorUserId);
      await audit(tx, opts.actorUserId, tenantId, "billing.resynced", { entityType: "subscription", entityId: sub.id, metadata: { provider: provider.provider, subscription: Boolean(snap), invoices: n } });
    });
    return { subscription: Boolean(snap), invoices: n };
  } catch (e) {
    if (e instanceof BillingProviderError) throw new BillingError("provider_failed");
    throw e;
  }
}

/** Owner's "Manage payment method": a Stripe Customer Portal session (card, invoices, billing details). Audited. */
export async function createBillingPortalSession(ctx: ServiceContext, opts: { returnUrl: string; locale: string | null; provider?: BillingProvider; auditAs?: { actorType: "user" | "impersonation"; impersonatedBy: string | null } }): Promise<{ url: string }> {
  const provider = opts.provider ?? getBillingProvider();
  const [sub] = await ctx.tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, ctx.tenantId)).limit(1);
  if (!sub?.externalCustomerId || !sub.externalSubscriptionId) throw new BillingError("not_managed");
  try {
    const session = await provider.createPortalSession(sub.externalCustomerId, opts.returnUrl, opts.locale);
    await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: opts.auditAs?.actorType ?? "user", impersonatedBy: opts.auditAs?.impersonatedBy ?? null, action: "billing.portal_opened", entityType: "subscription", entityId: sub.id });
    return session;
  } catch (e) {
    if (e instanceof BillingProviderError) throw new BillingError("provider_failed");
    throw e;
  }
}

/* ---------- views ---------- */

export interface BillingBanner {
  kind: "past_due" | "action_required";
  /** Stripe's hosted payment page of the invoice to settle, when there is one. */
  payUrl: string | null;
  daysOverdue: number;
  /** Days left before the suspension rule applies (past due only). */
  suspendsInDays: number | null;
}

/** The owner's banner: an invoice to authenticate (SCA) or a past-due balance, with the payment link. */
export async function tenantBillingBanner(ctx: ServiceContext, tenant: { status: string; suspendAfterDays: number }, now = new Date()): Promise<BillingBanner | null> {
  const open = await ctx.tx.select({ status: schema.invoices.status, dueAt: schema.invoices.dueAt, hostedUrl: schema.invoices.hostedUrl, paymentFailedAt: schema.invoices.paymentFailedAt, actionRequiredAt: schema.invoices.actionRequiredAt, issuedAt: schema.invoices.issuedAt }).from(schema.invoices).where(and(eq(schema.invoices.tenantId, ctx.tenantId), inArray(schema.invoices.status, ["open", "uncollectible"]))).orderBy(desc(schema.invoices.issuedAt)).limit(20);
  const action = open.find((i) => i.actionRequiredAt);
  if (action) return { kind: "action_required", payUrl: action.hostedUrl, daysOverdue: 0, suspendsInDays: null };
  const h = paymentHealth(open, now, tenant.suspendAfterDays);
  if (tenant.status !== "past_due" && h.health !== "past_due") return null;
  const target = open.find((i) => i.paymentFailedAt && i.hostedUrl) ?? open.find((i) => i.hostedUrl) ?? null;
  return { kind: "past_due", payUrl: target?.hostedUrl ?? null, daysOverdue: h.daysOverdue, suspendsInDays: Math.max(0, tenant.suspendAfterDays - h.daysOverdue) };
}

export interface TenantBillingView {
  subscription: typeof schema.subscriptions.$inferSelect | null;
  planKey: PlanKey;
  addons: { key: string; amountMinor: number }[];
  monthlyMinor: number;
  currency: string;
  nextInvoiceAt: Date | null;
  payment: { health: PaymentHealth; daysOverdue: number; openMinor: number };
  invoices: (typeof schema.invoices.$inferSelect)[];
  managed: boolean;
  banner: BillingBanner | null;
}

/** Settings → Billing (owner): plan, add-ons, next invoice, payment status, invoices. Read through RLS. */
export async function tenantBillingOverview(ctx: ServiceContext, tenant: { planKey: string; status: string; suspendAfterDays: number; activeAddons: readonly string[] }, now = new Date()): Promise<TenantBillingView> {
  const [subscription] = await ctx.tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, ctx.tenantId)).limit(1);
  const invoices = await ctx.tx.select().from(schema.invoices).where(eq(schema.invoices.tenantId, ctx.tenantId)).orderBy(desc(schema.invoices.issuedAt)).limit(36);
  const planKey = (PLAN_KEYS as readonly string[]).includes(tenant.planKey) ? (tenant.planKey as PlanKey) : "starter";
  const addons = tenant.activeAddons.filter((a) => isAddonModule(a) && MODULES[a].monthlyPriceMinor).map((a) => ({ key: a, amountMinor: MODULES[a as keyof typeof MODULES].monthlyPriceMinor ?? 0 }));
  const h = paymentHealth(invoices, now, tenant.suspendAfterDays);
  const managed = Boolean(subscription?.externalSubscriptionId);
  const live = managed && !["canceled", "incomplete_expired"].includes(subscription?.externalStatus ?? "");
  return {
    subscription: subscription ?? null,
    planKey,
    addons,
    monthlyMinor: monthlyChargeMinor(planKey, tenant.activeAddons),
    currency: PLANS[planKey].currency,
    nextInvoiceAt: subscription && tenant.status !== "churned" && (live || !managed) && !subscription.cancelAtPeriodEnd ? subscription.currentPeriodEnd : null,
    payment: { ...h, openMinor: invoices.filter((i) => i.status === "open" || i.status === "uncollectible").reduce((s, i) => s + i.amountMinor, 0) },
    invoices,
    managed,
    banner: await tenantBillingBanner(ctx, tenant, now),
  };
}

export interface ConsoleBillingOverview {
  settings: BillingSettings;
  mrrMinor: number;
  managedCount: number;
  failedPayments: { tenantId: string; tenantName: string; number: string; amountMinor: number; currency: string; failedAt: Date | null; attemptCount: number; nextAttemptAt: Date | null; actionRequired: boolean }[];
  pastDue: { tenantId: string; tenantName: string; status: string; statusChangedAt: Date | null; daysOverdue: number; suspendAfterDays: number }[];
  renewals: { tenantId: string; tenantName: string; planKey: string; at: Date; monthlyMinor: number; currency: string; cancelAtPeriodEnd: boolean }[];
  lastEvent: { type: string; receivedAt: Date; status: string } | null;
  failedEvents: number;
  catalog: CatalogRow[];
  subscriptions: { tenantId: string; tenantName: string; provider: string; externalStatus: string | null; collectionMethod: string | null; planKey: string; monthlyMinor: number; currency: string; currentPeriodEnd: Date; lastSyncedAt: Date | null; checkoutPending: boolean; vat: VatTreatment }[];
}

/** Console → Billing → Subscriptions: what Stripe collects, from the mirror. */
export async function consoleBillingOverview(db: Database, now = new Date(), settings = billingSettings()): Promise<ConsoleBillingOverview> {
  const subs = await db.select({ sub: schema.subscriptions, tenantName: schema.tenants.name, tenantStatus: schema.tenants.status }).from(schema.subscriptions).innerJoin(schema.tenants, eq(schema.tenants.id, schema.subscriptions.tenantId)).where(isNotNull(schema.subscriptions.externalSubscriptionId)).orderBy(asc(schema.tenants.name));
  const failed = await db.select({ inv: schema.invoices, tenantName: schema.tenants.name }).from(schema.invoices).innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId)).where(and(inArray(schema.invoices.status, ["open", "uncollectible"]), sql`(${schema.invoices.paymentFailedAt} is not null or ${schema.invoices.actionRequiredAt} is not null or ${schema.invoices.status} = 'uncollectible')`)).orderBy(desc(schema.invoices.issuedAt)).limit(50);
  const pastDueTenants = await db.select().from(schema.tenants).where(inArray(schema.tenants.status, ["past_due", "suspended"])).orderBy(asc(schema.tenants.name));
  const pastDue = [];
  for (const t of pastDueTenants) {
    const p = await tenantPaymentStatus(db, t.id, now);
    pastDue.push({ tenantId: t.id, tenantName: t.name, status: t.status, statusChangedAt: t.statusChangedAt, daysOverdue: p.daysOverdue, suspendAfterDays: t.suspendAfterDays });
  }
  const [last] = await db.select({ type: schema.billingEvents.type, receivedAt: schema.billingEvents.receivedAt, status: schema.billingEvents.status }).from(schema.billingEvents).orderBy(desc(schema.billingEvents.receivedAt)).limit(1);
  const [failedEv] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.billingEvents).where(eq(schema.billingEvents.status, "failed"));
  const monthly = (items: { unitAmountMinor: number; quantity: number; interval: string | null }[]) => items.filter((i) => i.interval === "month").reduce((s, i) => s + i.unitAmountMinor * i.quantity, 0);
  const horizon = new Date(now.getTime() + UPCOMING_RENEWAL_DAYS * 864e5);
  return {
    settings,
    mrrMinor: mirroredMrr(subs.map((s) => ({ externalStatus: s.sub.externalStatus, items: s.sub.items }))),
    managedCount: subs.filter((s) => subscriptionSignal(s.sub.externalStatus) !== "cancelled").length,
    failedPayments: failed.map(({ inv, tenantName }) => ({ tenantId: inv.tenantId, tenantName, number: inv.number, amountMinor: inv.amountMinor, currency: inv.currency, failedAt: inv.paymentFailedAt, attemptCount: inv.attemptCount, nextAttemptAt: inv.nextPaymentAttemptAt, actionRequired: Boolean(inv.actionRequiredAt) })),
    pastDue,
    renewals: subs.filter((s) => ["active", "trialing", "past_due"].includes(s.sub.externalStatus ?? "") && s.sub.currentPeriodEnd >= now && s.sub.currentPeriodEnd <= horizon).sort((a, b) => a.sub.currentPeriodEnd.getTime() - b.sub.currentPeriodEnd.getTime()).map((s) => ({ tenantId: s.sub.tenantId, tenantName: s.tenantName, planKey: s.sub.planKey, at: s.sub.currentPeriodEnd, monthlyMinor: monthly(s.sub.items), currency: s.sub.currency, cancelAtPeriodEnd: s.sub.cancelAtPeriodEnd })),
    lastEvent: last ?? null,
    failedEvents: failedEv?.n ?? 0,
    catalog: await billingCatalogState(db, settings.provider),
    subscriptions: subs.map((s) => ({ tenantId: s.sub.tenantId, tenantName: s.tenantName, provider: s.sub.provider, externalStatus: s.sub.externalStatus, collectionMethod: s.sub.collectionMethod, planKey: s.sub.planKey, monthlyMinor: monthly(s.sub.items), currency: s.sub.currency, currentPeriodEnd: s.sub.currentPeriodEnd, lastSyncedAt: s.sub.lastSyncedAt, checkoutPending: Boolean(s.sub.checkoutSessionId), vat: vatTreatment({ sellerCountry: settings.sellerCountry, customerCountry: s.sub.customerCountry, vatIdVerified: s.sub.customerTaxIds.some((t) => t.verified) }) })),
  };
}

/** Console tenant page: the Stripe side of one tenant, with drift between Keel's entitlements and the subscription items. */
export async function tenantSubscriptionDetail(db: Database, tenantId: string, settings = billingSettings()) {
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  const [tenant] = await db.select({ planKey: schema.tenants.planKey }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  const addons = (await db.select({ k: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.isActive, true)))).map((r) => r.k);
  const [emailRow] = await db.select({ email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, tenantId), eq(schema.tenantMemberships.role, "owner"), eq(schema.tenantMemberships.isActive, true))).orderBy(asc(schema.users.email)).limit(1);
  const managed = Boolean(sub?.externalSubscriptionId) && subscriptionSignal(sub?.externalStatus) !== "cancelled";
  const want = tenant ? desiredSubscriptionKeys(tenant.planKey as PlanKey, addons).sort() : [];
  const have = (sub?.items ?? []).map((i) => i.lookupKey ?? "").sort();
  return {
    subscription: sub ?? null,
    managed,
    drift: managed && JSON.stringify(want) !== JSON.stringify(have),
    defaultEmail: sub?.billingEmail ?? emailRow?.email ?? "",
    activeAddons: addons,
    vat: vatTreatment({ sellerCountry: settings.sellerCountry, customerCountry: sub?.customerCountry, vatIdVerified: (sub?.customerTaxIds ?? []).some((t) => t.verified) }),
    catalogReady: (await db.select({ n: sql<number>`count(*)::int` }).from(schema.billingPrices).where(and(eq(schema.billingPrices.provider, settings.provider), gte(schema.billingPrices.amountMinor, 0))))[0]!.n > 0,
  };
}

/** PDF of a Keel-ledger invoice (mock model, no processor document): Stripe invoices link to Stripe's own PDF. */
export function ledgerInvoicePdf(inv: typeof schema.invoices.$inferSelect, input: { sellerName: string; customerName: string; labels: { title: string; issued: string; due: string; item: string; amount: string; total: string; status: string; kinds: Record<string, string> }; money: (minor: number, currency: string) => string; date: (d: Date) => string }): { bytes: Uint8Array; filename: string } {
  const lines = inv.lines as { kind: string; key: string; amountMinor: number }[];
  const name = (l: { kind: string; key: string }) => (l.kind === "plan" || l.kind === "setup" || l.kind === "addon" ? (catalogItemFor(lookupKeyFor(l.kind, l.key))?.name ?? l.key) : l.key);
  const L = input.labels;
  const bytes = tablePdf({
    title: `${L.title} ${inv.number}`,
    header: [input.sellerName, input.customerName, `${L.issued}: ${input.date(inv.issuedAt)} · ${L.due}: ${input.date(inv.dueAt)}`, `${L.status}: ${inv.status}`],
    columns: [{ label: L.item, width: 360 }, { label: L.amount, width: 120, align: "right" }],
    rows: lines.map((l) => [`${name(l)} (${L.kinds[l.kind] ?? l.kind})`, input.money(l.amountMinor, inv.currency)]),
    totals: [[L.total, input.money(inv.amountMinor, inv.currency)]],
  });
  return { bytes, filename: `${inv.number}.pdf` };
}
