import type { SubscriptionCapabilities, SubscriptionInterval, SubscriptionStatus } from "@hullwise/core";
import { IntegrationError, type ConnectionTest, type Page, type SyncQuery } from "../types";
import type { HttpOptions } from "../http";
import { ShopifyCommercePlatform, type ShopifyCredentials } from "../shopify/adapter";
import { verifyWebhookHmac } from "../shopify/oauth";
import { gidToId } from "../shopify/mappers";
import { SUBSCRIPTION_SCOPES, dateOrNull, minorFrom, normalizeInterval, normalizePaymentError, type NormalizedBillingAttempt, type NormalizedSubscriptionContract, type SubscriptionProvider, type SubscriptionWebhook } from "./types";

type Rec = Record<string, unknown>;
const r = (v: unknown) => (v ?? {}) as Rec;
const idOf = (v: string) => gidToId(v) ?? v;
const nodes = (v: unknown) => ((r(v).nodes as Rec[] | undefined) ?? []);

/* Admin GraphQL fields of a subscription contract [to verify against the API version in use]. */
const CONTRACT_FIELDS = `id status createdAt updatedAt nextBillingDate currencyCode lastPaymentStatus
  customer { id email firstName lastName phone }
  customerPaymentMethod { id }
  billingPolicy { interval intervalCount }
  deliveryPrice { amount }
  originOrder { id }
  lines(first: 20) { nodes { id quantity variantId productId sku title variantTitle currentPrice { amount } lineDiscountedPrice { amount } } }
  discounts(first: 10) { nodes { id title } }`;
const ATTEMPT_FIELDS = `billingAttempts(first: 20, reverse: true) { nodes { id createdAt completedAt ready errorCode errorMessage originTime order { id } } }`;

const STATUS: Record<string, SubscriptionStatus> = { ACTIVE: "active", PAUSED: "paused", CANCELLED: "cancelled", EXPIRED: "expired", FAILED: "failed" };
const INTERVAL_OUT: Record<SubscriptionInterval, string> = { day: "DAY", week: "WEEK", month: "MONTH", year: "YEAR" };

/** One Admin GraphQL `SubscriptionContract` normalized. */
export function mapShopifyContract(c: Rec): NormalizedSubscriptionContract {
  const status = STATUS[String(c.status)] ?? "active";
  const lines = nodes(c.lines).map((l) => {
    const unit = minorFrom(r(l.lineDiscountedPrice).amount ?? r(l.currentPrice).amount) / Math.max(1, Number(l.quantity ?? 1));
    return { externalId: idOf(String(l.id)), variantExternalId: l.variantId ? idOf(String(l.variantId)) : null, productExternalId: l.productId ? idOf(String(l.productId)) : null, sku: (l.sku as string | null) ?? null, title: String(l.title ?? ""), variantTitle: (l.variantTitle as string | null) ?? null, quantity: Number(l.quantity ?? 1), unitPriceMinor: Math.round(unit) };
  });
  const cust = c.customer ? r(c.customer) : null;
  const ended = status === "cancelled" || status === "expired" || status === "failed";
  const updatedAt = new Date(String(c.updatedAt ?? c.createdAt));
  const policy = r(c.billingPolicy);
  return {
    externalId: idOf(String(c.id)),
    status,
    customer: cust ? { externalId: cust.id ? idOf(String(cust.id)) : null, email: (cust.email as string | null) ?? null, firstName: (cust.firstName as string | null) ?? null, lastName: (cust.lastName as string | null) ?? null, phone: (cust.phone as string | null) ?? null } : null,
    currency: String(c.currencyCode ?? "USD"),
    lines,
    intervalUnit: normalizeInterval(policy.interval as string),
    intervalCount: Number(policy.intervalCount ?? 1),
    nextBillingAt: ended ? null : dateOrNull(c.nextBillingDate),
    priceMinor: lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0) + minorFrom(r(c.deliveryPrice).amount),
    discounts: nodes(c.discounts).map((d) => ({ code: null, title: (d.title as string | null) ?? null, amountMinor: 0 })),
    createdAt: new Date(String(c.createdAt)),
    endedAt: ended ? updatedAt : null,
    pausedAt: status === "paused" ? updatedAt : null,
    // Shopify keeps no cancellation reason on the contract; the app's own reason (if any) arrives through Hullwise's cancel action
    cancellationReasonRaw: null,
    cancelledForNonPayment: status === "failed" || (status === "cancelled" && c.lastPaymentStatus === "FAILED"),
    originOrderExternalId: c.originOrder ? idOf(String(r(c.originOrder).id)) : null,
    updatedAt,
  };
}

export function mapShopifyBillingAttempt(contractExternalId: string, currency: string, amountMinor: number, a: Rec): NormalizedBillingAttempt {
  const order = a.order ? idOf(String(r(a.order).id)) : null;
  const failed = Boolean(a.errorCode);
  const origin = String(a.originTime ?? a.createdAt);
  return {
    externalId: idOf(String(a.id)),
    contractExternalId,
    status: order ? "success" : failed ? "failed" : "pending",
    errorCode: failed ? normalizePaymentError(String(a.errorCode), a.errorMessage as string | null) : null,
    errorMessage: (a.errorMessage as string | null) ?? null,
    amountMinor,
    currency,
    orderExternalId: order,
    attemptedAt: new Date(String(a.completedAt ?? a.createdAt)),
    // the subscription app schedules retries itself; the Admin API does not expose the next one [to verify]
    nextRetryAt: null,
    cycleKey: origin.slice(0, 10),
  };
}

/**
 * Shopify native subscriptions (Admin GraphQL subscription contracts). Uses the store's Shopify
 * credentials with `read_own_subscription_contracts` / `write_own_subscription_contracts`: an app
 * reads only the contracts it owns, so contracts created by the Shopify Subscriptions app need the
 * merchant to grant access [to verify with Shopify before a live install].
 */
export class ShopifySubscriptionProvider implements SubscriptionProvider {
  readonly provider = "shopify_subscriptions" as const;
  readonly capabilities: SubscriptionCapabilities = { canPause: true, canResume: true, canSkip: true, canSwap: true, canChangeFrequency: true, canReschedule: true, canCancel: true, canSendPaymentLink: true };
  readonly shopify: ShopifyCommercePlatform;

  constructor(private readonly creds: ShopifyCredentials, opts: HttpOptions = {}) {
    this.shopify = new ShopifyCommercePlatform(creds, opts);
  }

  private gql<T>(query: string, variables: Record<string, unknown> = {}) {
    return this.shopify.graphql<T>(query, variables);
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const d = await this.gql<{ shop: { name: string; id: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(`{ shop { name id } currentAppInstallation { accessScopes { handle } } }`);
      const scopes = d.currentAppInstallation.accessScopes.map((s) => s.handle);
      const missing = SUBSCRIPTION_SCOPES.shopify_subscriptions.slice(0, 2).filter((s) => !scopes.includes(s));
      return { ok: missing.length === 0, accountName: d.shop.name, accountId: idOf(d.shop.id), scopes, missingScopes: missing, error: missing.length ? `Missing scopes: ${missing.join(", ")}` : undefined };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async fetchContracts(q: SyncQuery): Promise<Page<NormalizedSubscriptionContract>> {
    const query = q.updatedSince ? `updated_at:>='${q.updatedSince.toISOString()}'` : null;
    const d = await this.gql<{ subscriptionContracts: { nodes: Rec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(`query($first: Int!, $after: String, $query: String) { subscriptionContracts(first: $first, after: $after, query: $query) { nodes { ${CONTRACT_FIELDS} } pageInfo { hasNextPage endCursor } } }`, { first: Math.min(q.limit ?? 50, 100), after: q.cursor ?? null, query });
    return { items: d.subscriptionContracts.nodes.map(mapShopifyContract), nextCursor: d.subscriptionContracts.pageInfo.hasNextPage ? d.subscriptionContracts.pageInfo.endCursor : null };
  }

  async fetchContract(externalId: string): Promise<NormalizedSubscriptionContract | null> {
    const d = await this.gql<{ subscriptionContract: Rec | null }>(`query($id: ID!) { subscriptionContract(id: $id) { ${CONTRACT_FIELDS} } }`, { id: `gid://shopify/SubscriptionContract/${externalId}` });
    return d.subscriptionContract ? mapShopifyContract(d.subscriptionContract) : null;
  }

  async fetchBillingAttempts(q: SyncQuery): Promise<Page<NormalizedBillingAttempt>> {
    const query = q.createdSince ? `updated_at:>='${q.createdSince.toISOString()}'` : null;
    const d = await this.gql<{ subscriptionContracts: { nodes: Rec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(`query($first: Int!, $after: String, $query: String) { subscriptionContracts(first: $first, after: $after, query: $query) { nodes { id currencyCode deliveryPrice { amount } lines(first: 20) { nodes { quantity lineDiscountedPrice { amount } currentPrice { amount } } } ${ATTEMPT_FIELDS} } pageInfo { hasNextPage endCursor } } }`, { first: Math.min(q.limit ?? 50, 100), after: q.cursor ?? null, query });
    const items = d.subscriptionContracts.nodes.flatMap((c) => {
      const amount = nodes(c.lines).reduce((s, l) => s + minorFrom(r(l.lineDiscountedPrice).amount ?? r(l.currentPrice).amount), 0) + minorFrom(r(c.deliveryPrice).amount);
      return nodes(c.billingAttempts).map((a) => mapShopifyBillingAttempt(idOf(String(c.id)), String(c.currencyCode ?? "USD"), amount, a)).filter((a) => !q.createdSince || a.attemptedAt.getTime() >= q.createdSince.getTime());
    });
    return { items, nextCursor: d.subscriptionContracts.pageInfo.hasNextPage ? d.subscriptionContracts.pageInfo.endCursor : null };
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<SubscriptionWebhook> {
    if (!verifyWebhookHmac(rawBody, headers["x-shopify-hmac-sha256"], this.creds.apiSecret)) throw new IntegrationError("permission", "Invalid webhook signature");
    const payload = JSON.parse(rawBody) as Rec;
    const contract = payload.admin_graphql_api_subscription_contract_id ?? payload.subscription_contract_id ?? payload.admin_graphql_api_id ?? payload.id;
    return { topic: headers["x-shopify-topic"] ?? "unknown", externalId: headers["x-shopify-event-id"] ?? headers["x-shopify-webhook-id"] ?? String(payload.id ?? ""), sourceUpdatedAt: String(payload.updated_at ?? ""), payload, contractExternalId: contract ? idOf(String(contract)) : null };
  }

  private gid(id: string) {
    return `gid://shopify/SubscriptionContract/${id}`;
  }

  private async mutateContract(name: string, query: string, variables: Record<string, unknown>): Promise<NormalizedSubscriptionContract> {
    const d = await this.gql<Record<string, { contract?: Rec | null; userErrors?: { message: string }[] }>>(query, variables);
    const res = d[name];
    if (res?.userErrors?.length) throw new IntegrationError("invalid_request", res.userErrors.map((e) => e.message).join("; "));
    if (!res?.contract) throw new IntegrationError("unknown", `${name}: no contract returned`);
    return mapShopifyContract(res.contract);
  }

  pause(externalId: string): Promise<NormalizedSubscriptionContract> {
    return this.mutateContract("subscriptionContractPause", `mutation($id: ID!) { subscriptionContractPause(subscriptionContractId: $id) { contract { ${CONTRACT_FIELDS} } userErrors { field message } } }`, { id: this.gid(externalId) });
  }
  resume(externalId: string): Promise<NormalizedSubscriptionContract> {
    return this.mutateContract("subscriptionContractActivate", `mutation($id: ID!) { subscriptionContractActivate(subscriptionContractId: $id) { contract { ${CONTRACT_FIELDS} } userErrors { field message } } }`, { id: this.gid(externalId) });
  }
  cancel(externalId: string): Promise<NormalizedSubscriptionContract> {
    return this.mutateContract("subscriptionContractCancel", `mutation($id: ID!) { subscriptionContractCancel(subscriptionContractId: $id) { contract { ${CONTRACT_FIELDS} } userErrors { field message } } }`, { id: this.gid(externalId) });
  }
  reschedule(externalId: string, nextBillingAt: Date): Promise<NormalizedSubscriptionContract> {
    return this.mutateContract("subscriptionContractSetNextBillingDate", `mutation($id: ID!, $date: DateTime!) { subscriptionContractSetNextBillingDate(contractId: $id, date: $date) { contract { ${CONTRACT_FIELDS} } userErrors { field message } } }`, { id: this.gid(externalId), date: nextBillingAt.toISOString() });
  }
  async skipNext(externalId: string): Promise<NormalizedSubscriptionContract> {
    const d = await this.gql<{ subscriptionBillingCycleSkip: { userErrors: { message: string }[] } }>(`mutation($input: SubscriptionBillingCycleInput!) { subscriptionBillingCycleSkip(billingCycleInput: $input) { billingCycle { cycleIndex skipped } userErrors { field message } } }`, { input: { contractId: this.gid(externalId), selector: { index: 1 } } });
    if (d.subscriptionBillingCycleSkip.userErrors.length) throw new IntegrationError("invalid_request", d.subscriptionBillingCycleSkip.userErrors.map((e) => e.message).join("; "));
    const c = await this.fetchContract(externalId);
    if (!c) throw new IntegrationError("not_found", "Contract not found after skip");
    return c;
  }
  /** Line and policy changes go through a draft: update → edit → commit. */
  private async withDraft(externalId: string, edit: (draftId: string) => Promise<void>): Promise<NormalizedSubscriptionContract> {
    const u = await this.gql<{ subscriptionContractUpdate: { draft: { id: string } | null; userErrors: { message: string }[] } }>(`mutation($id: ID!) { subscriptionContractUpdate(contractId: $id) { draft { id } userErrors { field message } } }`, { id: this.gid(externalId) });
    if (!u.subscriptionContractUpdate.draft) throw new IntegrationError("invalid_request", u.subscriptionContractUpdate.userErrors.map((e) => e.message).join("; ") || "No draft");
    await edit(u.subscriptionContractUpdate.draft.id);
    return this.mutateContract("subscriptionDraftCommit", `mutation($id: ID!) { subscriptionDraftCommit(draftId: $id) { contract { ${CONTRACT_FIELDS} } userErrors { field message } } }`, { id: u.subscriptionContractUpdate.draft.id });
  }
  swapVariant(externalId: string, input: { lineExternalId: string; variantExternalId: string; quantity?: number }): Promise<NormalizedSubscriptionContract> {
    return this.withDraft(externalId, async (draftId) => {
      const d = await this.gql<{ subscriptionDraftLineUpdate: { userErrors: { message: string }[] } }>(`mutation($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) { subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) { userErrors { field message } } }`, { draftId, lineId: `gid://shopify/SubscriptionLine/${input.lineExternalId}`, input: { productVariantId: `gid://shopify/ProductVariant/${input.variantExternalId}`, ...(input.quantity ? { quantity: input.quantity } : {}) } });
      if (d.subscriptionDraftLineUpdate.userErrors.length) throw new IntegrationError("invalid_request", d.subscriptionDraftLineUpdate.userErrors.map((e) => e.message).join("; "));
    });
  }
  changeFrequency(externalId: string, input: { unit: SubscriptionInterval; count: number }): Promise<NormalizedSubscriptionContract> {
    return this.withDraft(externalId, async (draftId) => {
      const policy = { interval: INTERVAL_OUT[input.unit], intervalCount: input.count };
      const d = await this.gql<{ subscriptionDraftUpdate: { userErrors: { message: string }[] } }>(`mutation($draftId: ID!, $input: SubscriptionDraftInput!) { subscriptionDraftUpdate(draftId: $draftId, input: $input) { userErrors { field message } } }`, { draftId, input: { billingPolicy: policy, deliveryPolicy: policy } });
      if (d.subscriptionDraftUpdate.userErrors.length) throw new IntegrationError("invalid_request", d.subscriptionDraftUpdate.userErrors.map((e) => e.message).join("; "));
    });
  }
  async sendPaymentUpdateLink(externalId: string): Promise<{ sent: boolean }> {
    const c = await this.gql<{ subscriptionContract: { customerPaymentMethod: { id: string } | null } | null }>(`query($id: ID!) { subscriptionContract(id: $id) { customerPaymentMethod { id } } }`, { id: this.gid(externalId) });
    const pm = c.subscriptionContract?.customerPaymentMethod?.id;
    if (!pm) throw new IntegrationError("not_found", "The contract has no payment method to update");
    const d = await this.gql<{ customerPaymentMethodSendUpdateEmail: { customer: { id: string } | null; userErrors: { message: string }[] } }>(`mutation($id: ID!) { customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $id) { customer { id } userErrors { field message } } }`, { id: pm });
    if (d.customerPaymentMethodSendUpdateEmail.userErrors.length) throw new IntegrationError("invalid_request", d.customerPaymentMethodSendUpdateEmail.userErrors.map((e) => e.message).join("; "));
    return { sent: Boolean(d.customerPaymentMethodSendUpdateEmail.customer) };
  }
}
