import type { CheckoutSnapshot, CustomerSnapshot, InvoiceSnapshot, SubscriptionItemSnapshot, SubscriptionSnapshot } from "./types";

/**
 * Stripe JSON → Keel snapshots. The same shapes come from API responses and webhook payloads.
 * Both the pre-2025 layout and the "basil" one (periods on subscription items, invoice parent,
 * line pricing) are read, so a change of account API version does not break the mirror.
 */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ts = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);
const list = (v: unknown): Obj[] => (Array.isArray(obj(v).data) ? (obj(v).data as unknown[]).map(obj) : []);
const meta = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === "string") as [string, string][]);

export interface StripeEvent {
  id: string;
  type: string;
  created: Date;
  livemode: boolean;
  object: Obj;
}

export function parseStripeEvent(payload: unknown): StripeEvent | null {
  const p = obj(payload);
  const id = str(p.id);
  const type = str(p.type);
  if (!id || !type || p.object !== "event") return null;
  return { id, type, created: ts(p.created) ?? new Date(0), livemode: p.livemode === true, object: obj(obj(p.data).object) };
}

function paymentMethodSummary(v: unknown): string | null {
  const pm = obj(v);
  const card = obj(pm.card);
  if (str(card.last4)) return `${str(card.brand) ?? "card"} •••• ${str(card.last4)}`;
  const sepa = obj(pm.sepa_debit);
  if (str(sepa.last4)) return `SEPA •••• ${str(sepa.last4)}`;
  return str(pm.type);
}

export function toSubscriptionSnapshot(raw: unknown): SubscriptionSnapshot {
  const s = obj(raw);
  const itemsRaw = list(s.items);
  const items: SubscriptionItemSnapshot[] = itemsRaw.map((i) => {
    const price = obj(i.price);
    return { itemId: str(i.id) ?? "", priceId: str(price.id) ?? "", lookupKey: str(price.lookup_key), unitAmountMinor: num(price.unit_amount), currency: (str(price.currency) ?? "").toUpperCase(), interval: obj(price.recurring).interval === "month" ? "month" : null, quantity: typeof i.quantity === "number" ? i.quantity : 1 };
  });
  const first = itemsRaw[0] ?? {};
  return {
    id: str(s.id) ?? "",
    customerId: idOf(s.customer) ?? "",
    status: str(s.status) ?? "incomplete",
    collectionMethod: s.collection_method === "send_invoice" ? "send_invoice" : "charge_automatically",
    currentPeriodStart: ts(s.current_period_start) ?? ts(first.current_period_start),
    currentPeriodEnd: ts(s.current_period_end) ?? ts(first.current_period_end),
    trialEnd: ts(s.trial_end),
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    canceledAt: ts(s.canceled_at),
    cancellationReason: str(obj(s.cancellation_details).reason),
    items,
    metadata: meta(s.metadata),
    paymentMethodSummary: typeof s.default_payment_method === "object" ? paymentMethodSummary(s.default_payment_method) : null,
    latestInvoiceId: idOf(s.latest_invoice),
  };
}

export function toInvoiceSnapshot(raw: unknown): InvoiceSnapshot {
  const i = obj(raw);
  const parentSub = obj(obj(i.parent).subscription_details);
  const oldSub = obj(i.subscription_details);
  const transitions = obj(i.status_transitions);
  const taxes = Array.isArray(i.total_taxes) ? (i.total_taxes as unknown[]).reduce<number>((s, t) => s + num(obj(t).amount), 0) : null;
  const total = num(i.total);
  const tax = typeof i.tax === "number" ? i.tax : taxes ?? (typeof i.total_excluding_tax === "number" ? total - i.total_excluding_tax : 0);
  return {
    id: str(i.id) ?? "",
    number: str(i.number),
    customerId: idOf(i.customer),
    subscriptionId: idOf(i.subscription) ?? idOf(parentSub.subscription),
    status: str(i.status) ?? "draft",
    collectionMethod: str(i.collection_method),
    billingReason: str(i.billing_reason),
    currency: (str(i.currency) ?? "").toUpperCase(),
    totalMinor: total,
    subtotalMinor: num(i.subtotal),
    taxMinor: tax,
    hostedUrl: str(i.hosted_invoice_url),
    pdfUrl: str(i.invoice_pdf),
    attemptCount: num(i.attempt_count),
    nextPaymentAttemptAt: ts(i.next_payment_attempt),
    createdAt: ts(i.created) ?? new Date(0),
    finalizedAt: ts(transitions.finalized_at),
    dueAt: ts(i.due_date),
    paidAt: ts(transitions.paid_at),
    periodStart: ts(i.period_start),
    periodEnd: ts(i.period_end),
    lines: list(i.lines).map((l) => {
      const price = obj(l.price);
      const pricing = obj(obj(l.pricing).price_details);
      const parent = obj(obj(l.parent).subscription_item_details);
      return { priceId: str(price.id) ?? str(pricing.price), lookupKey: str(price.lookup_key), description: str(l.description), amountMinor: num(l.amount), proration: l.proration === true || parent.proration === true };
    }),
    lastPaymentError: str(obj(i.last_finalization_error).message),
    metadata: meta(i.metadata),
    subscriptionTenantId: str(obj(parentSub.metadata).keel_tenant_id) ?? str(obj(oldSub.metadata).keel_tenant_id),
  };
}

export function toCustomerSnapshot(raw: unknown): CustomerSnapshot {
  const c = obj(raw);
  return {
    id: str(c.id) ?? "",
    email: str(c.email),
    name: str(c.name),
    country: str(obj(c.address).country),
    taxExempt: str(c.tax_exempt),
    taxIds: list(c.tax_ids).map((t) => ({ type: str(t.type) ?? "", value: str(t.value) ?? "", verified: obj(t.verification).status === "verified" })),
    metadata: meta(c.metadata),
  };
}

export function toCheckoutSnapshot(raw: unknown): CheckoutSnapshot {
  const c = obj(raw);
  return { id: str(c.id) ?? "", customerId: idOf(c.customer), subscriptionId: idOf(c.subscription), clientReferenceId: str(c.client_reference_id), status: str(c.status), paymentStatus: str(c.payment_status), metadata: meta(c.metadata) };
}
