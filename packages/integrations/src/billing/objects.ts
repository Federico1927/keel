/**
 * Stripe-shaped objects and events (API version 2025-03-31 "basil" layout), built from plain
 * inputs. The mock provider's simulated webhooks and the Stripe test double both use them, so the
 * code that reads real payloads is the code the demo exercises.
 */
type Obj = Record<string, unknown>;
const sec = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : null);

export interface StripeItemInput {
  itemId: string;
  priceId: string;
  lookupKey: string | null;
  unitAmountMinor: number;
  currency: string;
  interval: "month" | null;
  quantity?: number;
}

export function stripeEvent(type: string, object: Obj, opts: { id: string; created: Date; livemode?: boolean }): Obj {
  return { id: opts.id, object: "event", api_version: "2025-03-31.basil", created: sec(opts.created), livemode: opts.livemode ?? false, pending_webhooks: 1, type, data: { object } };
}

export function stripePriceObject(i: Omit<StripeItemInput, "itemId" | "quantity"> & { productId?: string }): Obj {
  return { id: i.priceId, object: "price", active: true, currency: i.currency.toLowerCase(), lookup_key: i.lookupKey, product: i.productId ?? null, type: i.interval ? "recurring" : "one_time", recurring: i.interval ? { interval: i.interval, interval_count: 1, usage_type: "licensed" } : null, unit_amount: i.unitAmountMinor, tax_behavior: "exclusive" };
}

export function stripeSubscriptionObject(s: { id: string; customerId: string; tenantId: string; status: string; items: StripeItemInput[]; periodStart: Date; periodEnd: Date; trialEnd?: Date | null; collectionMethod?: "charge_automatically" | "send_invoice"; cancelAtPeriodEnd?: boolean; canceledAt?: Date | null; cancellationReason?: string | null; latestInvoiceId?: string | null; created?: Date; paymentMethod?: { brand: string; last4: string } | null }): Obj {
  return {
    id: s.id,
    object: "subscription",
    customer: s.customerId,
    status: s.status,
    collection_method: s.collectionMethod ?? "charge_automatically",
    cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
    canceled_at: sec(s.canceledAt),
    cancellation_details: { reason: s.cancellationReason ?? null, comment: null, feedback: null },
    created: sec(s.created ?? s.periodStart),
    start_date: sec(s.created ?? s.periodStart),
    trial_end: sec(s.trialEnd),
    latest_invoice: s.latestInvoiceId ?? null,
    default_payment_method: s.paymentMethod ? { id: "pm_card", object: "payment_method", type: "card", card: { brand: s.paymentMethod.brand, last4: s.paymentMethod.last4 } } : null,
    metadata: { hullwise_tenant_id: s.tenantId },
    items: { object: "list", data: s.items.map((i) => ({ id: i.itemId, object: "subscription_item", quantity: i.quantity ?? 1, current_period_start: sec(s.periodStart), current_period_end: sec(s.periodEnd), price: stripePriceObject(i) })) },
  };
}

export function stripeInvoiceObject(i: { id: string; number: string | null; customerId: string; subscriptionId: string | null; tenantId: string; status: string; billingReason: string; currency: string; lines: { priceId: string | null; description: string; amountMinor: number; proration?: boolean }[]; taxMinor?: number; created: Date; finalizedAt?: Date | null; dueDate?: Date | null; paidAt?: Date | null; attemptCount?: number; nextPaymentAttempt?: Date | null; hostedUrl?: string | null; pdfUrl?: string | null; collectionMethod?: string; periodStart?: Date; periodEnd?: Date }): Obj {
  const subtotal = i.lines.reduce((s, l) => s + l.amountMinor, 0);
  const tax = i.taxMinor ?? 0;
  return {
    id: i.id,
    object: "invoice",
    number: i.number,
    customer: i.customerId,
    status: i.status,
    collection_method: i.collectionMethod ?? "charge_automatically",
    billing_reason: i.billingReason,
    currency: i.currency.toLowerCase(),
    subtotal,
    total: subtotal + tax,
    total_excluding_tax: subtotal,
    total_taxes: tax ? [{ amount: tax, tax_behavior: "exclusive", taxability_reason: "standard_rated" }] : [],
    amount_due: subtotal + tax,
    amount_paid: i.status === "paid" ? subtotal + tax : 0,
    attempt_count: i.attemptCount ?? 0,
    next_payment_attempt: sec(i.nextPaymentAttempt),
    created: sec(i.created),
    due_date: sec(i.dueDate),
    period_start: sec(i.periodStart ?? i.created),
    period_end: sec(i.periodEnd ?? i.created),
    hosted_invoice_url: i.hostedUrl ?? null,
    invoice_pdf: i.pdfUrl ?? null,
    status_transitions: { finalized_at: sec(i.finalizedAt ?? (i.status === "draft" ? null : i.created)), paid_at: sec(i.paidAt), voided_at: null, marked_uncollectible_at: null },
    metadata: {},
    parent: i.subscriptionId ? { type: "subscription_details", subscription_details: { subscription: i.subscriptionId, metadata: { hullwise_tenant_id: i.tenantId } } } : null,
    lines: { object: "list", data: i.lines.map((l, n) => ({ id: `il_${i.id}_${n}`, object: "line_item", amount: l.amountMinor, currency: i.currency.toLowerCase(), description: l.description, pricing: { type: "price_details", price_details: { price: l.priceId, product: null } }, parent: { type: "subscription_item_details", subscription_item_details: { proration: l.proration ?? false } } })) },
  };
}

export function stripeCheckoutObject(c: { id: string; customerId: string; subscriptionId: string | null; tenantId: string; status: "open" | "complete" | "expired"; paymentStatus: "paid" | "unpaid" | "no_payment_required"; url?: string | null; expiresAt?: Date | null }): Obj {
  return { id: c.id, object: "checkout.session", mode: "subscription", customer: c.customerId, subscription: c.subscriptionId, client_reference_id: c.tenantId, status: c.status, payment_status: c.paymentStatus, url: c.url ?? null, expires_at: sec(c.expiresAt), metadata: { hullwise_tenant_id: c.tenantId } };
}

export function stripeCustomerObject(c: { id: string; tenantId: string; name: string; email?: string | null; country?: string | null; taxExempt?: string; taxIds?: { type: string; value: string; verified: boolean }[] }): Obj {
  return { id: c.id, object: "customer", name: c.name, email: c.email ?? null, address: c.country ? { country: c.country } : null, tax_exempt: c.taxExempt ?? "none", metadata: { hullwise_tenant_id: c.tenantId }, tax_ids: { object: "list", data: (c.taxIds ?? []).map((t, n) => ({ id: `txi_${n}`, object: "tax_id", type: t.type, value: t.value, verification: { status: t.verified ? "verified" : "unverified" } })) } };
}
