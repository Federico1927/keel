import { HttpClient, type HttpOptions } from "@keel/integrations";

export interface BillingInvoiceInput {
  customerId: string;
  number: string;
  currency: string;
  lines: { key: string; label: string; amountMinor: number }[];
  dueAt: Date;
}

/** Payment processor contract; Keel owns the invoice ledger, the provider only collects. */
export interface BillingProvider {
  readonly provider: "mock" | "stripe";
  ensureCustomer(tenant: { id: string; name: string; email?: string | null }): Promise<string>;
  createInvoice(input: BillingInvoiceInput): Promise<{ externalId: string; hostedUrl: string | null }>;
  fetchInvoiceStatus(externalId: string): Promise<"open" | "paid" | "void" | "uncollectible">;
}

/** Default: no processor. Invoices live only in Keel and are marked paid by the super-admin. */
export class MockBillingProvider implements BillingProvider {
  readonly provider = "mock" as const;
  readonly paid = new Set<string>();
  async ensureCustomer(tenant: { id: string }): Promise<string> {
    return `mock_cus_${tenant.id.slice(0, 8)}`;
  }
  async createInvoice(input: BillingInvoiceInput): Promise<{ externalId: string; hostedUrl: string | null }> {
    return { externalId: `mock_in_${input.number}`, hostedUrl: null };
  }
  async fetchInvoiceStatus(externalId: string): Promise<"open" | "paid" | "void" | "uncollectible"> {
    return this.paid.has(externalId) ? "paid" : "open";
  }
}

/** Stripe in test mode over the REST API (no SDK); used only when STRIPE_SECRET_KEY is set. */
export class StripeBillingProvider implements BillingProvider {
  readonly provider = "stripe" as const;
  private readonly http: HttpClient;
  constructor(private readonly secretKey: string, opts: HttpOptions = {}) {
    this.http = new HttpClient(opts);
  }
  private async call<T>(path: string, body?: Record<string, string>): Promise<T> {
    const res = await this.http.request<T>(`https://api.stripe.com/v1/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body: body ? new URLSearchParams(body).toString() : undefined });
    return res.json;
  }
  async ensureCustomer(tenant: { id: string; name: string; email?: string | null }): Promise<string> {
    const found = await this.call<{ data: { id: string }[] }>(`customers/search?query=${encodeURIComponent(`metadata['keel_tenant_id']:'${tenant.id}'`)}`);
    if (found.data?.[0]) return found.data[0].id;
    const created = await this.call<{ id: string }>("customers", { name: tenant.name, ...(tenant.email ? { email: tenant.email } : {}), "metadata[keel_tenant_id]": tenant.id });
    return created.id;
  }
  async createInvoice(input: BillingInvoiceInput): Promise<{ externalId: string; hostedUrl: string | null }> {
    for (const l of input.lines) await this.call("invoiceitems", { customer: input.customerId, amount: String(l.amountMinor), currency: input.currency.toLowerCase(), description: l.label, "metadata[key]": l.key });
    const days = Math.max(1, Math.ceil((input.dueAt.getTime() - Date.now()) / 864e5));
    const inv = await this.call<{ id: string }>("invoices", { customer: input.customerId, collection_method: "send_invoice", days_until_due: String(days), "metadata[keel_number]": input.number });
    const fin = await this.call<{ id: string; hosted_invoice_url?: string }>(`invoices/${inv.id}/finalize`, {});
    return { externalId: fin.id, hostedUrl: fin.hosted_invoice_url ?? null };
  }
  async fetchInvoiceStatus(externalId: string): Promise<"open" | "paid" | "void" | "uncollectible"> {
    const inv = await this.call<{ status: string }>(`invoices/${externalId}`);
    return inv.status === "paid" ? "paid" : inv.status === "void" ? "void" : inv.status === "uncollectible" ? "uncollectible" : "open";
  }
}

let cached: BillingProvider | null = null;
export function getBillingProvider(): BillingProvider {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  cached = key ? new StripeBillingProvider(key) : new MockBillingProvider();
  return cached;
}
