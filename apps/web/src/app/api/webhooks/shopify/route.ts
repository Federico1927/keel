import { NextResponse, after, type NextRequest } from "next/server";
import { adminDb, and, eq, schema, withTenant } from "@keel/db";
import { IntegrationError } from "@keel/integrations";
import { getCommercePlatformFor, processWebhookEvent, recordWebhookEvent } from "@keel/services";
import { enqueue } from "@/server/jobs";

/**
 * Shopify webhook endpoint: resolve the tenant from the shop domain, verify the HMAC with
 * that tenant's secret, store the event (unique on source/topic/id/updated_at), answer 200
 * immediately and process in the background (queue, or inline when no worker is around).
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const shop = headers["x-shopify-shop-domain"];
  if (!shop) return new NextResponse("missing shop domain", { status: 400 });
  const [integration] = await adminDb().select({ tenantId: schema.integrations.tenantId }).from(schema.integrations).where(and(eq(schema.integrations.provider, "shopify"), eq(schema.integrations.externalAccountId, shop))).limit(1);
  if (!integration) return new NextResponse("unknown shop", { status: 404 });
  const [tenant] = await adminDb().select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, integration.tenantId)).limit(1);
  if (!tenant) return new NextResponse("unknown tenant", { status: 404 });

  let recorded: { id: string | null; duplicate: boolean };
  try {
    recorded = await withTenant(tenant.id, async (tx) => {
      const ctx = { tenantId: tenant.id, tx, actor: { type: "integration" as const, userId: null } };
      const platform = await getCommercePlatformFor(ctx, tenant);
      const verified = await platform.verifyWebhook(headers, rawBody);
      return recordWebhookEvent(ctx, { source: "shopify", ...verified });
    });
  } catch (e) {
    if (e instanceof IntegrationError && e.code === "permission") return new NextResponse("invalid signature", { status: 401 });
    if (e instanceof SyntaxError) return new NextResponse("invalid payload", { status: 400 });
    throw e;
  }
  if (recorded.duplicate || !recorded.id) return NextResponse.json({ ok: true, duplicate: true });
  const eventId = recorded.id;
  after(async () => {
    const queued = await enqueue("webhook.process", { tenantId: tenant.id, eventId });
    if (!queued) {
      await withTenant(tenant.id, async (tx) => {
        const ctx = { tenantId: tenant.id, tx, actor: { type: "integration" as const, userId: null } };
        await processWebhookEvent(ctx, await getCommercePlatformFor(ctx, tenant), eventId, { country: tenant.country });
      });
    }
  });
  return NextResponse.json({ ok: true, id: eventId });
}
