import type { FetchLike } from "../http";
import { formList, parseForm } from "./form";
import { stripeCheckoutObject, stripeCustomerObject, stripeEvent, stripeInvoiceObject, stripePriceObject, stripeSubscriptionObject, type StripeItemInput } from "./objects";

/**
 * In-memory Stripe for tests (never imported by the app): answers the REST calls the
 * StripeBillingProvider makes with payloads shaped like recorded Stripe responses, honours
 * Idempotency-Key, and plays the Stripe side of a billing cycle (checkout completed, renewal,
 * failed charge, retry paid…) returning the webhook events Stripe would send.
 */
type Obj = Record<string, unknown>;

interface FakePrice {
  id: string;
  product: string;
  currency: string;
  unitAmount: number;
  interval: "month" | null;
  lookupKey: string | null;
  active: boolean;
}
interface FakeSub {
  id: string;
  customer: string;
  tenantId: string;
  status: string;
  collection: "charge_automatically" | "send_invoice";
  items: StripeItemInput[];
  periodStart: Date;
  periodEnd: Date;
  trialEnd: Date | null;
  latestInvoice: string | null;
  canceledAt: Date | null;
  cancellationReason: string | null;
}
interface FakeInvoice {
  id: string;
  number: string;
  customer: string;
  subscription: string | null;
  tenantId: string;
  status: string;
  billingReason: string;
  lines: { priceId: string | null; description: string; amountMinor: number }[];
  created: Date;
  dueDate: Date | null;
  paidAt: Date | null;
  attemptCount: number;
  nextAttempt: Date | null;
  collection: string;
}

export class FakeStripe {
  readonly calls: { method: string; path: string; body: Obj; idempotencyKey: string | null; authorization: string | null }[] = [];
  readonly products = new Map<string, { id: string; name: string; active: boolean }>();
  readonly prices = new Map<string, FakePrice>();
  readonly customers = new Map<string, { id: string; tenantId: string; name: string; email: string | null; country: string | null; taxExempt: string; taxIds: { type: string; value: string; verified: boolean }[] }>();
  readonly sessions = new Map<string, { id: string; customer: string; tenantId: string; priceIds: string[]; trialDays: number; status: "open" | "complete" }>();
  readonly subscriptions = new Map<string, FakeSub>();
  readonly invoices = new Map<string, FakeInvoice>();
  private readonly idempotent = new Map<string, { status: number; body: string }>();
  private seq = 0;
  constructor(public now: Date = new Date()) {}

  private next(prefix: string) {
    return `${prefix}_${String(++this.seq).padStart(6, "0")}`;
  }

  /* ---------- REST ---------- */

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1\//, "");
    const method = init?.method ?? "GET";
    const body = method === "POST" ? parseForm(init?.body ?? "") : Object.fromEntries(u.searchParams);
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const key = headers["idempotency-key"] ?? null;
    this.calls.push({ method, path, body, idempotencyKey: key, authorization: headers.authorization ?? null });
    const respond = (status: number, json: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(json) });
    if (key && this.idempotent.has(key)) {
      const r = this.idempotent.get(key)!;
      return { status: r.status, headers: { get: () => null }, text: async () => r.body };
    }
    const [status, json] = this.route(method, path, body, u.searchParams);
    if (key && method === "POST") this.idempotent.set(key, { status, body: JSON.stringify(json) });
    return respond(status, json);
  };

  private notFound(what: string): [number, Obj] {
    return [404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` } }];
  }

  private route(method: string, path: string, body: Obj, query: URLSearchParams): [number, unknown] {
    const seg = path.split("/");
    if (path === "customers/search") {
      const id = /'([^']+)'$/.exec(query.get("query") ?? "")?.[1];
      return [200, { object: "search_result", data: [...this.customers.values()].filter((c) => c.tenantId === id).map((c) => this.customerJson(c.id)) }];
    }
    if (path === "customers" && method === "POST") {
      const id = this.next("cus");
      this.customers.set(id, { id, tenantId: String((body.metadata as Obj | undefined)?.hullwise_tenant_id ?? ""), name: String(body.name ?? ""), email: (body.email as string) ?? null, country: null, taxExempt: "none", taxIds: [] });
      return [200, this.customerJson(id)];
    }
    if (seg[0] === "customers" && seg[1] && method === "POST") {
      const c = this.customers.get(seg[1]);
      if (!c) return this.notFound("customer");
      if (body.tax_exempt) c.taxExempt = String(body.tax_exempt);
      return [200, this.customerJson(c.id)];
    }
    if (seg[0] === "products") {
      if (method === "GET") {
        const p = this.products.get(decodeURIComponent(seg[1] ?? ""));
        return p ? [200, { id: p.id, object: "product", name: p.name, active: p.active }] : this.notFound("product");
      }
      const id = seg[1] ? decodeURIComponent(seg[1]) : String(body.id);
      const p = this.products.get(id) ?? { id, name: "", active: true };
      if (body.name) p.name = String(body.name);
      if (body.active !== undefined) p.active = body.active === "true";
      this.products.set(id, p);
      return [200, { id: p.id, object: "product", name: p.name, active: p.active }];
    }
    if (path === "prices" && method === "GET") {
      const keys = new Set([...query.entries()].filter(([k]) => k.startsWith("lookup_keys")).map(([, v]) => v));
      return [200, { object: "list", data: [...this.prices.values()].filter((p) => p.active && p.lookupKey && keys.has(p.lookupKey)).map((p) => this.priceJson(p)) }];
    }
    if (path === "prices" && method === "POST") {
      const lookupKey = (body.lookup_key as string) ?? null;
      if (lookupKey && body.transfer_lookup_key === "true") for (const p of this.prices.values()) if (p.lookupKey === lookupKey) p.lookupKey = null;
      const id = this.next("price");
      const p: FakePrice = { id, product: String(body.product), currency: String(body.currency), unitAmount: Number(body.unit_amount), interval: (body.recurring as Obj | undefined)?.interval === "month" ? "month" : null, lookupKey, active: true };
      this.prices.set(id, p);
      return [200, this.priceJson(p)];
    }
    if (seg[0] === "prices" && seg[1] && method === "POST") {
      const p = this.prices.get(seg[1]);
      if (!p) return this.notFound("price");
      if (body.active !== undefined) p.active = body.active === "true";
      return [200, this.priceJson(p)];
    }
    if (path === "checkout/sessions" && method === "POST") {
      const id = this.next("cs_test");
      const items = formList<Obj>(body.line_items).map((l) => String(l.price));
      const trialDays = Number((body.subscription_data as Obj | undefined)?.trial_period_days ?? 0);
      this.sessions.set(id, { id, customer: String(body.customer), tenantId: String(body.client_reference_id), priceIds: items, trialDays, status: "open" });
      return [200, { ...stripeCheckoutObject({ id, customerId: String(body.customer), subscriptionId: null, tenantId: String(body.client_reference_id), status: "open", paymentStatus: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, expiresAt: new Date(this.now.getTime() + 24 * 3600_000) }) }];
    }
    if (path === "subscriptions" && method === "POST") {
      const tenantId = String((body.metadata as Obj | undefined)?.hullwise_tenant_id ?? "");
      const recurring = formList<Obj>(body.items).map((i) => String(i.price));
      const oneOff = formList<Obj>(body.add_invoice_items).map((i) => String(i.price));
      const sub = this.createSub(String(body.customer), tenantId, recurring, Number(body.trial_period_days ?? 0), "send_invoice");
      const inv = this.createInvoice(sub, [...recurring, ...oneOff], "subscription_create", "open", Number(body.days_until_due ?? 14));
      sub.latestInvoice = inv.id;
      return [200, this.subJson(sub)];
    }
    if (seg[0] === "subscriptions" && seg[1]) {
      const sub = this.subscriptions.get(seg[1]);
      if (!sub) return this.notFound("subscription");
      if (method === "POST") {
        for (const it of formList<Obj>(body.items)) {
          if (it.deleted === "true") sub.items = sub.items.filter((x) => x.itemId !== it.id);
          else if (it.id) sub.items = sub.items.map((x) => (x.itemId === it.id ? { ...this.item(String(it.price)), itemId: x.itemId } : x));
          else sub.items.push(this.item(String(it.price)));
        }
      }
      return [200, this.subJson(sub)];
    }
    if (path === "invoices" && method === "GET") {
      const customer = query.get("customer");
      return [200, { object: "list", data: [...this.invoices.values()].filter((i) => i.customer === customer).map((i) => this.invoiceJson(i.id)) }];
    }
    if (path === "billing_portal/sessions" && method === "POST") return [200, { id: this.next("bps"), object: "billing_portal.session", url: `https://billing.stripe.com/p/session/${this.seq}`, return_url: body.return_url }];
    return this.notFound(`route ${method} ${path}`);
  }

  /* ---------- objects ---------- */

  private item(priceId: string): StripeItemInput {
    const p = this.prices.get(priceId);
    return { itemId: this.next("si"), priceId, lookupKey: p?.lookupKey ?? null, unitAmountMinor: p?.unitAmount ?? 0, currency: p?.currency ?? "usd", interval: p?.interval ?? null };
  }
  private priceJson(p: FakePrice): Obj {
    return stripePriceObject({ priceId: p.id, productId: p.product, lookupKey: p.lookupKey, unitAmountMinor: p.unitAmount, currency: p.currency, interval: p.interval });
  }
  customerJson(id: string): Obj {
    const c = this.customers.get(id)!;
    return stripeCustomerObject({ id: c.id, tenantId: c.tenantId, name: c.name, email: c.email, country: c.country, taxExempt: c.taxExempt, taxIds: c.taxIds });
  }
  subJson(sub: FakeSub): Obj {
    return stripeSubscriptionObject({ id: sub.id, customerId: sub.customer, tenantId: sub.tenantId, status: sub.status, items: sub.items, periodStart: sub.periodStart, periodEnd: sub.periodEnd, trialEnd: sub.trialEnd, collectionMethod: sub.collection, latestInvoiceId: sub.latestInvoice, canceledAt: sub.canceledAt, cancellationReason: sub.cancellationReason, paymentMethod: sub.collection === "charge_automatically" ? { brand: "visa", last4: "4242" } : null });
  }
  invoiceJson(id: string): Obj {
    const i = this.invoices.get(id)!;
    return stripeInvoiceObject({ id: i.id, number: i.number, customerId: i.customer, subscriptionId: i.subscription, tenantId: i.tenantId, status: i.status, billingReason: i.billingReason, currency: "usd", lines: i.lines, created: i.created, dueDate: i.dueDate, paidAt: i.paidAt, attemptCount: i.attemptCount, nextPaymentAttempt: i.nextAttempt, hostedUrl: `https://invoice.stripe.com/i/${i.id}`, pdfUrl: `https://pay.stripe.com/invoice/${i.id}/pdf`, collectionMethod: i.collection, periodStart: i.created, periodEnd: i.created });
  }

  private createSub(customer: string, tenantId: string, recurring: string[], trialDays: number, collection: FakeSub["collection"]): FakeSub {
    const start = new Date(this.now);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const trialEnd = trialDays ? new Date(start.getTime() + trialDays * 864e5) : null;
    const sub: FakeSub = { id: this.next("sub"), customer, tenantId, status: trialDays ? "trialing" : "active", collection, items: recurring.map((p) => this.item(p)), periodStart: start, periodEnd: trialEnd ?? end, trialEnd, latestInvoice: null, canceledAt: null, cancellationReason: null };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  private createInvoice(sub: FakeSub, priceIds: string[], reason: string, status: string, daysUntilDue?: number): FakeInvoice {
    const id = this.next("in");
    const n = [...this.invoices.values()].filter((i) => i.customer === sub.customer).length + 1;
    const lines = priceIds.map((p) => {
      const price = this.prices.get(p);
      return { priceId: p, description: `1 × ${price?.product ?? p}`, amountMinor: sub.status === "trialing" && price?.interval ? 0 : (price?.unitAmount ?? 0) };
    });
    const inv: FakeInvoice = { id, number: `HULLWISE-${String(n).padStart(4, "0")}`, customer: sub.customer, subscription: sub.id, tenantId: sub.tenantId, status, billingReason: reason, lines, created: new Date(this.now), dueDate: sub.collection === "send_invoice" ? new Date(this.now.getTime() + (daysUntilDue ?? 14) * 864e5) : null, paidAt: status === "paid" ? new Date(this.now) : null, attemptCount: status === "paid" ? 1 : 0, nextAttempt: null, collection: sub.collection };
    this.invoices.set(id, inv);
    return inv;
  }

  private event(type: string, object: Obj): Obj {
    return stripeEvent(type, object, { id: this.next("evt"), created: this.now });
  }

  /* ---------- the Stripe side of a billing cycle ---------- */

  /** The customer paid on the Checkout page: subscription created, first invoice (plan, add-ons, setup fee) paid. */
  completeCheckout(sessionId: string): Obj[] {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    s.status = "complete";
    const recurring = s.priceIds.filter((p) => this.prices.get(p)?.interval);
    const sub = this.createSub(s.customer, s.tenantId, recurring, s.trialDays, "charge_automatically");
    const inv = this.createInvoice(sub, s.priceIds, "subscription_create", "paid");
    sub.latestInvoice = inv.id;
    return [
      this.event("checkout.session.completed", stripeCheckoutObject({ id: s.id, customerId: s.customer, subscriptionId: sub.id, tenantId: s.tenantId, status: "complete", paymentStatus: "paid" })),
      this.event("customer.subscription.created", this.subJson(sub)),
      this.event("invoice.finalized", { ...this.invoiceJson(inv.id), status: "open", status_transitions: { finalized_at: Math.floor(this.now.getTime() / 1000), paid_at: null } }),
      this.event("invoice.paid", this.invoiceJson(inv.id)),
    ];
  }

  /** The period ended: a renewal invoice. With `fail`, the charge is declined and Smart Retries schedule another attempt. */
  renew(subscriptionId: string, opts: { fail?: boolean } = {}): Obj[] {
    const sub = this.subscriptions.get(subscriptionId)!;
    sub.periodStart = sub.periodEnd;
    const end = new Date(sub.periodStart);
    end.setUTCMonth(end.getUTCMonth() + 1);
    sub.periodEnd = end;
    if (sub.status === "trialing") sub.status = "active";
    const inv = this.createInvoice(sub, sub.items.map((i) => i.priceId), "subscription_cycle", opts.fail ? "open" : "paid");
    sub.latestInvoice = inv.id;
    if (!opts.fail) return [this.event("invoice.finalized", { ...this.invoiceJson(inv.id), status: "open" }), this.event("invoice.paid", this.invoiceJson(inv.id)), this.event("customer.subscription.updated", this.subJson(sub))];
    inv.attemptCount = 1;
    inv.nextAttempt = new Date(this.now.getTime() + 3 * 864e5);
    sub.status = "past_due";
    return [this.event("invoice.finalized", this.invoiceJson(inv.id)), this.event("invoice.payment_failed", this.invoiceJson(inv.id)), this.event("customer.subscription.updated", this.subJson(sub))];
  }

  /** The bank asks the customer to authenticate the charge (SCA). */
  actionRequired(invoiceId: string): Obj[] {
    return [this.event("invoice.payment_action_required", this.invoiceJson(invoiceId))];
  }

  /** A retry (or the customer through the hosted page) paid the invoice. */
  pay(invoiceId: string): Obj[] {
    const inv = this.invoices.get(invoiceId)!;
    inv.status = "paid";
    inv.paidAt = new Date(this.now);
    inv.attemptCount += 1;
    inv.nextAttempt = null;
    const sub = inv.subscription ? this.subscriptions.get(inv.subscription) : undefined;
    if (sub && sub.status === "past_due") sub.status = "active";
    return [this.event("invoice.paid", this.invoiceJson(inv.id)), ...(sub ? [this.event("customer.subscription.updated", this.subJson(sub))] : [])];
  }

  markUncollectible(invoiceId: string): Obj[] {
    const inv = this.invoices.get(invoiceId)!;
    inv.status = "uncollectible";
    return [this.event("invoice.marked_uncollectible", this.invoiceJson(inv.id))];
  }

  cancel(subscriptionId: string, reason: "cancellation_requested" | "payment_failed"): Obj[] {
    const sub = this.subscriptions.get(subscriptionId)!;
    sub.status = "canceled";
    sub.canceledAt = new Date(this.now);
    sub.cancellationReason = reason;
    return [this.event("customer.subscription.deleted", this.subJson(sub))];
  }

  updateCustomer(customerId: string, patch: { country?: string; taxIds?: { type: string; value: string; verified: boolean }[]; email?: string }): Obj[] {
    const c = this.customers.get(customerId)!;
    if (patch.country) c.country = patch.country;
    if (patch.taxIds) c.taxIds = patch.taxIds;
    if (patch.email) c.email = patch.email;
    return [this.event("customer.updated", this.customerJson(c.id))];
  }
}
