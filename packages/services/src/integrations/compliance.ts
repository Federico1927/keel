import { and, eq, or, recordAudit, schema, sql, withTenant, type Database } from "@hullwise/db";
import { SHOPIFY_COMPLIANCE_TOPICS, decryptJson, verifyWebhookHmac, type ShopifyComplianceTopic, type ShopifyCredentials } from "@hullwise/integrations";
import { recordWebhookEvent } from "../sync";
import { raisePlatformAlert } from "../reliability/alerts";
import { redactCustomer, type CustomerRedactionReport } from "../crm/redact";

/**
 * Shopify's mandatory privacy webhooks (issue #89), one endpoint for the three topics:
 * - `customers/data_request`: logged, audited and turned into a console task (compliance alert) with the
 *   Hullwise customer it concerns; the platform owner sends the customer's data to the merchant.
 * - `customers/redact`: the customer's personal data and that of the listed orders is erased at once
 *   (`redactCustomer`: names, contacts, addresses, raw payloads; amounts and dates stay), audited; no task.
 * - `shop/redact` (48 h after uninstall): the Shopify connection is cleared (no credentials kept) and a task
 *   asks for the tenant's data deletion through the console's lifecycle (churn + retention purge).
 * Every request is acknowledged with 200 once its signature is valid; a duplicate is acknowledged and ignored.
 * The tenant is resolved from the shop domain with the admin connection (Shopify sends nothing else), like
 * the order webhooks; everything written for the tenant goes through its RLS transaction.
 */
export interface ComplianceInput {
  topic: string;
  shop: string;
  rawBody: string;
  hmac: string | undefined;
  /** The platform app's secret (`SHOPIFY_API_SECRET`), for stores connected through the public app. */
  platformSecret?: string | null;
  now?: Date;
  /** Connection for the tenant's RLS transaction (default: the app connection; tests pass theirs). */
  tenantDb?: Database;
}
export interface ComplianceResult {
  status: 200 | 400 | 401;
  tenantId: string | null;
  action: "logged" | "redacted" | "duplicate" | "unknown_shop" | "invalid_signature" | "invalid_payload" | "unknown_topic";
}

interface AppConfig {
  app?: { shop?: string; clientId?: string; secretEncrypted?: string };
}

const isTopic = (t: string): t is ShopifyComplianceTopic => (SHOPIFY_COMPLIANCE_TOPICS as readonly string[]).includes(t);

/** Every secret that may sign this shop's webhooks, with the tenant it belongs to. */
async function candidateSecrets(db: Database, shop: string, platformSecret: string | null | undefined): Promise<{ tenantId: string | null; secret: string }[]> {
  const rows = await db.select({ tenantId: schema.integrations.tenantId, credentials: schema.integrations.credentialsEncrypted, config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.provider, "shopify"), or(eq(schema.integrations.externalAccountId, shop), sql`${schema.integrations.config} -> 'app' ->> 'shop' = ${shop}`)));
  const out: { tenantId: string | null; secret: string }[] = [];
  const withoutOwnApp: string[] = [];
  for (const r of rows) {
    const before = out.length;
    try {
      if (r.credentials) out.push({ tenantId: r.tenantId, secret: decryptJson<ShopifyCredentials>(r.credentials).apiSecret });
    } catch {
      /* unreadable credentials (key rotated): try the others */
    }
    const app = (r.config as AppConfig | null)?.app;
    try {
      if (app?.secretEncrypted) out.push({ tenantId: r.tenantId, secret: decryptJson<{ clientSecret: string }>(app.secretEncrypted).clientSecret });
    } catch {
      /* idem */
    }
    if (out.length === before) withoutOwnApp.push(r.tenantId);
  }
  // the platform app signs for the stores without an app of their own (a store with its own app never accepts it)
  if (platformSecret && (rows.length === 0 || withoutOwnApp.length)) out.push({ tenantId: withoutOwnApp.length === 1 ? withoutOwnApp[0]! : null, secret: platformSecret });
  return out;
}

/** The request's own id: the data request id, the customer id, or the shop id. */
function requestRef(topic: ShopifyComplianceTopic, p: Record<string, unknown>): string {
  const customer = (p.customer ?? {}) as { id?: unknown };
  const dataRequest = (p.data_request ?? {}) as { id?: unknown };
  if (topic === "customers/data_request") return String(dataRequest.id ?? customer.id ?? p.shop_id ?? "unknown");
  if (topic === "customers/redact") return String(customer.id ?? p.shop_id ?? "unknown");
  return String(p.shop_id ?? p.shop_domain ?? "unknown");
}

export async function handleShopifyCompliance(db: Database, input: ComplianceInput): Promise<ComplianceResult> {
  if (!isTopic(input.topic)) return { status: 400, tenantId: null, action: "unknown_topic" };
  const topic = input.topic;
  const candidates = await candidateSecrets(db, input.shop, input.platformSecret);
  const match = candidates.find((c) => verifyWebhookHmac(input.rawBody, input.hmac, c.secret));
  if (!match) return { status: 401, tenantId: null, action: "invalid_signature" };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, tenantId: null, action: "invalid_payload" };
  }
  if (!match.tenantId) return { status: 200, tenantId: null, action: "unknown_shop" };
  const tenantId = match.tenantId;
  const now = input.now ?? new Date();
  const ref = requestRef(topic, payload);
  const customerExternalId = (payload.customer as { id?: unknown } | undefined)?.id;
  // no email or phone is stored: the platform ids are enough to find the data in Hullwise
  const minimal = { shop_id: payload.shop_id ?? null, shop_domain: payload.shop_domain ?? input.shop, customer_id: customerExternalId ?? null, orders: payload.orders_requested ?? payload.orders_to_redact ?? [], data_request_id: (payload.data_request as { id?: unknown } | undefined)?.id ?? null };
  const outcome = await withTenant(tenantId, async (tx) => {
    const ctx = { tenantId, tx, actor: { type: "integration" as const, userId: null }, now };
    const recorded = await recordWebhookEvent(ctx, { source: "shopify_compliance", topic, externalId: ref, sourceUpdatedAt: "", payload: minimal });
    if (recorded.duplicate || !recorded.id) return { duplicate: true, customerId: null as string | null, redaction: null as CustomerRedactionReport | null };
    const [customer] = customerExternalId ? await tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, tenantId), eq(schema.customers.externalId, String(customerExternalId)))).limit(1) : [];
    if (topic === "shop/redact") await tx.update(schema.integrations).set({ status: "not_connected", credentialsEncrypted: null, mode: "mock", lastError: "The store asked Shopify to erase its data (shop/redact)", updatedAt: now }).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.provider, "shopify")));
    const ordersToRedact = Array.isArray(payload.orders_to_redact) ? (payload.orders_to_redact as unknown[]).filter((v): v is string | number => typeof v === "string" || typeof v === "number") : [];
    const redaction = topic === "customers/redact" ? await redactCustomer(ctx, { customerId: customer?.id ?? null, orderExternalIds: ordersToRedact }) : null;
    await recordAudit(tx, { tenantId, actorType: "system", action: `integration.compliance.${topic.replace("/", ".")}`, entityType: customer ? "customer" : "integration", entityId: customer?.id ?? "shopify", metadata: { ...minimal, customerFound: !!customer, ...(redaction ? { redaction } : {}) } });
    await tx.update(schema.webhookEvents).set({ status: "processed", processedAt: now, attempts: 1 }).where(eq(schema.webhookEvents.id, recorded.id));
    return { duplicate: false, customerId: customer?.id ?? null, redaction };
  }, input.tenantDb);
  if (outcome.duplicate) return { status: 200, tenantId, action: "duplicate" };
  // the erasure is done and audited: nothing left for the platform owner to do
  if (topic === "customers/redact") return { status: 200, tenantId, action: "redacted" };
  await raisePlatformAlert(db, { kind: "compliance_request", tenantId, subject: `shopify:${topic}:${ref}`, error: topic === "shop/redact" ? "Delete the tenant's data (lifecycle: churn, then retention purge) within 30 days." : "Send this customer's data to the merchant within 30 days.", now, meta: { ...minimal, customerId: outcome.customerId } }, { notifyTenant: false });
  return { status: 200, tenantId, action: "logged" };
}
