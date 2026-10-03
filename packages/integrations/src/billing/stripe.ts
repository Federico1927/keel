import { catalogChange, stripeKeyMode, type CatalogItem } from "@hullwise/core";
import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError } from "../types";
import { encodeForm, type FormValue } from "./form";
import { toInvoiceSnapshot, toSubscriptionSnapshot } from "./parse";
import { BillingProviderError, type BillingCustomerInput, type BillingInvoiceInput, type BillingProvider, type CatalogSyncResult, type CheckoutInput, type CheckoutSession, type InvoiceSnapshot, type SubscriptionSnapshot, type SubscriptionStartInput } from "./types";

/** API version every request pins (Da verificare: confirm against the account's version before go-live). */
export const STRIPE_API_VERSION = "2025-03-31.basil";
const API = "https://api.stripe.com/v1";

type Obj = Record<string, unknown>;

/**
 * Stripe over the REST API (no SDK), used only when STRIPE_SECRET_KEY is set. Works with a
 * restricted key (`rk_…`) limited to products, prices, customers, Checkout, subscriptions,
 * invoices and portal sessions. Creates carry an Idempotency-Key, so a retried call never
 * duplicates a product, a price or a subscription. The key only travels in the auth header.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly provider = "stripe" as const;
  readonly mode: "test" | "live";
  private readonly http: HttpClient;
  constructor(
    private readonly secretKey: string,
    opts: HttpOptions = {},
  ) {
    this.mode = stripeKeyMode(secretKey) ?? "test";
    this.http = new HttpClient(opts);
  }

  private async call<T = Obj>(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, FormValue>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}`, "stripe-version": STRIPE_API_VERSION };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    try {
      const res = await this.http.request<T>(`${API}/${path}`, { method, headers, body: method === "POST" ? encodeForm(body ?? {}) : undefined });
      return res.json;
    } catch (e) {
      if (e instanceof IntegrationError) throw new BillingProviderError(e.code === "not_found" ? "not_found" : e.code === "network" || e.code === "rate_limited" ? "network" : "invalid_request", e.message.replace(/(sk|rk)_(test|live)_\w+/g, "[key]"));
      throw e;
    }
  }

  private async getOrNull<T = Obj>(path: string): Promise<T | null> {
    try {
      return await this.call<T>("GET", path);
    } catch (e) {
      if (e instanceof BillingProviderError && e.code === "not_found") return null;
      throw e;
    }
  }

  async ensureCustomer(input: BillingCustomerInput): Promise<string> {
    const found = await this.call<{ data: { id: string }[] }>("GET", `customers/search?query=${encodeURIComponent(`metadata['hullwise_tenant_id']:'${input.tenantId}'`)}`);
    if (found.data?.[0]) return found.data[0].id;
    const created = await this.call<{ id: string }>("POST", "customers", { name: input.name, email: input.email ?? undefined, preferred_locales: input.locale ? [input.locale] : undefined, metadata: { hullwise_tenant_id: input.tenantId } }, `hullwise-customer-${input.tenantId}`);
    return created.id;
  }

  async syncCatalog(items: readonly CatalogItem[]): Promise<CatalogSyncResult[]> {
    const prices = new Map<string, Obj>();
    for (let i = 0; i < items.length; i += 10) {
      const keys = items.slice(i, i + 10).map((x, n) => `lookup_keys[${n}]=${encodeURIComponent(x.lookupKey)}`).join("&");
      const res = await this.call<{ data: Obj[] }>("GET", `prices?active=true&limit=100&${keys}`);
      for (const p of res.data ?? []) if (typeof p.lookup_key === "string") prices.set(p.lookup_key, p);
    }
    const out: CatalogSyncResult[] = [];
    for (const item of items) {
      const product = await this.getOrNull<Obj>(`products/${encodeURIComponent(item.productId)}`);
      const p = prices.get(item.lookupKey);
      const recurring = (p?.recurring ?? null) as Obj | null;
      const change = catalogChange(item, {
        product: product ? { name: String(product.name ?? ""), active: product.active !== false } : null,
        price: p ? { id: String(p.id), productId: typeof p.product === "string" ? p.product : String((p.product as Obj | undefined)?.id ?? ""), amountMinor: Number(p.unit_amount ?? 0), currency: String(p.currency ?? ""), interval: recurring?.interval === "month" ? "month" : null } : null,
      });
      const metadata = { hullwise_kind: item.kind, hullwise_key: item.key };
      if (change.createProduct) await this.call("POST", "products", { id: item.productId, name: item.name, metadata }, `hullwise-product-${item.productId}`);
      else if (change.updateProduct) await this.call("POST", `products/${encodeURIComponent(item.productId)}`, { name: item.name, active: true, metadata });
      let priceId = p ? String(p.id) : "";
      if (change.createPrice) {
        const created = await this.call<{ id: string }>(
          "POST",
          "prices",
          { product: item.productId, currency: item.currency.toLowerCase(), unit_amount: item.amountMinor, lookup_key: item.lookupKey, transfer_lookup_key: true, recurring: item.interval ? { interval: item.interval } : undefined, tax_behavior: "exclusive", metadata },
          `hullwise-price-${item.lookupKey}-${item.amountMinor}-${item.currency.toLowerCase()}-${item.interval ?? "once"}`,
        );
        priceId = created.id;
      }
      if (change.archivePriceId) await this.call("POST", `prices/${encodeURIComponent(change.archivePriceId)}`, { active: false });
      out.push({ lookupKey: item.lookupKey, productId: item.productId, priceId, amountMinor: item.amountMinor, currency: item.currency, interval: item.interval, outcome: change.createProduct || change.createPrice ? "created" : change.updateProduct ? "updated" : "unchanged", archivedPriceId: change.archivePriceId });
    }
    return out;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession> {
    const s = await this.call<Obj>(
      "POST",
      "checkout/sessions",
      {
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.tenantId,
        line_items: [...input.priceIds, ...input.oneOffPriceIds].map((price) => ({ price, quantity: 1 })),
        subscription_data: { trial_period_days: input.trialDays || undefined, metadata: { hullwise_tenant_id: input.tenantId } },
        metadata: { hullwise_tenant_id: input.tenantId },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        locale: input.locale ?? "auto",
        billing_address_collection: "required",
        // VAT ids collected at Checkout; with Stripe Tax a verified EU id abroad means reverse charge
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        automatic_tax: { enabled: input.automaticTax },
        payment_method_collection: "always",
      },
      input.idempotencyKey,
    );
    return { id: String(s.id), url: String(s.url), expiresAt: typeof s.expires_at === "number" ? new Date(s.expires_at * 1000) : null };
  }

  async createInvoicedSubscription(input: SubscriptionStartInput & { daysUntilDue: number }): Promise<SubscriptionSnapshot> {
    const s = await this.call<Obj>(
      "POST",
      "subscriptions",
      {
        customer: input.customerId,
        items: input.priceIds.map((price) => ({ price })),
        add_invoice_items: input.oneOffPriceIds.map((price) => ({ price })),
        collection_method: "send_invoice",
        days_until_due: input.daysUntilDue,
        trial_period_days: input.trialDays || undefined,
        automatic_tax: { enabled: input.automaticTax },
        metadata: { hullwise_tenant_id: input.tenantId },
      },
      input.idempotencyKey,
    );
    return toSubscriptionSnapshot(s);
  }

  async updateSubscriptionItems(subscriptionId: string, changes: { add: string[]; remove: string[]; swap: { itemId: string; priceId: string }[] }, idempotencyKey: string): Promise<SubscriptionSnapshot> {
    const items = [...changes.swap.map((s) => ({ id: s.itemId, price: s.priceId })), ...changes.remove.map((id) => ({ id, deleted: true })), ...changes.add.map((price) => ({ price }))];
    const s = await this.call<Obj>("POST", `subscriptions/${encodeURIComponent(subscriptionId)}`, { items, proration_behavior: "create_prorations", "expand[]": "default_payment_method" }, idempotencyKey);
    return toSubscriptionSnapshot(s);
  }

  async createPortalSession(customerId: string, returnUrl: string, locale: string | null): Promise<{ url: string }> {
    const s = await this.call<{ url: string }>("POST", "billing_portal/sessions", { customer: customerId, return_url: returnUrl, locale: locale ?? "auto" });
    return { url: s.url };
  }

  async fetchSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    const s = await this.getOrNull<Obj>(`subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=default_payment_method`);
    return s ? toSubscriptionSnapshot(s) : null;
  }

  async cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<SubscriptionSnapshot | null> {
    try {
      // DELETE cancels at once; Stripe's defaults issue no final invoice and no proration
      return toSubscriptionSnapshot(await this.call<Obj>("DELETE", `subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, idempotencyKey));
    } catch (e) {
      if (e instanceof BillingProviderError && e.code === "not_found") return null;
      throw e;
    }
  }

  async listInvoices(customerId: string, limit = 24): Promise<InvoiceSnapshot[]> {
    const res = await this.call<{ data: Obj[] }>("GET", `invoices?customer=${encodeURIComponent(customerId)}&limit=${Math.min(100, limit)}`);
    return (res.data ?? []).map(toInvoiceSnapshot);
  }

  async setCustomerTaxExempt(customerId: string, value: "none" | "exempt" | "reverse"): Promise<void> {
    await this.call("POST", `customers/${encodeURIComponent(customerId)}`, { tax_exempt: value });
  }

  async createInvoice(input: BillingInvoiceInput): Promise<{ externalId: string; hostedUrl: string | null }> {
    for (const l of input.lines) await this.call("POST", "invoiceitems", { customer: input.customerId, amount: l.amountMinor, currency: input.currency.toLowerCase(), description: l.label, metadata: { key: l.key } }, `hullwise-ii-${input.number}-${l.key}`);
    const days = Math.max(1, Math.ceil((input.dueAt.getTime() - Date.now()) / 864e5));
    const inv = await this.call<{ id: string }>("POST", "invoices", { customer: input.customerId, collection_method: "send_invoice", days_until_due: days, pending_invoice_items_behavior: "include", metadata: { hullwise_number: input.number } }, `hullwise-invoice-${input.number}`);
    const fin = await this.call<{ id: string; hosted_invoice_url?: string }>("POST", `invoices/${inv.id}/finalize`, {});
    return { externalId: fin.id, hostedUrl: fin.hosted_invoice_url ?? null };
  }

  async fetchInvoiceStatus(externalId: string): Promise<"open" | "paid" | "void" | "uncollectible"> {
    const inv = await this.call<{ status: string }>("GET", `invoices/${encodeURIComponent(externalId)}`);
    return inv.status === "paid" ? "paid" : inv.status === "void" ? "void" : inv.status === "uncollectible" ? "uncollectible" : "open";
  }
}
