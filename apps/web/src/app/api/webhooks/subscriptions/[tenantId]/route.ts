import { NextResponse, type NextRequest } from "next/server";
import { adminDb, and, eq, schema, withTenant } from "@hullwise/db";
import { IntegrationError } from "@hullwise/integrations";
import { SUBSCRIPTIONS_ADDON, getSubscriptionProviderFor, processSubscriptionWebhook } from "@hullwise/services";

/**
 * Webhooks of the tenant's subscription app (addon.subscriptions, #67): signature checked by the
 * provider's adapter, the event stored once, the contract read back and imported. Refused (404) for
 * tenants without the add-on or without a connected subscription app.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) return new NextResponse("not found", { status: 404 });
  const [addon] = await adminDb().select({ id: schema.tenantAddons.id }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, SUBSCRIPTIONS_ADDON), eq(schema.tenantAddons.isActive, true))).limit(1);
  if (!addon) return new NextResponse("not found", { status: 404 });
  const raw = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  try {
    const r = await withTenant(tenantId, async (tx) => {
      const ctx = { tenantId, tx, actor: { type: "integration" as const, userId: null } };
      const provider = await getSubscriptionProviderFor(ctx);
      return provider ? processSubscriptionWebhook(ctx, provider, headers, raw) : null;
    });
    if (!r) return new NextResponse("not found", { status: 404 });
    return NextResponse.json({ ok: true, status: r.status });
  } catch (e) {
    if (e instanceof IntegrationError && e.code === "permission") return new NextResponse("invalid signature", { status: 401 });
    if (e instanceof SyntaxError) return new NextResponse("invalid payload", { status: 400 });
    throw e;
  }
}
