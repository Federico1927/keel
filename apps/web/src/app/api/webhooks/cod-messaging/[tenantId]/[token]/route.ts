import { NextResponse, type NextRequest } from "next/server";
import { adminDb, and, eq, schema, withTenant } from "@keel/db";
import { applyMessageStatus } from "@keel/addon-cod";
import { getMessagingChannelFor } from "@keel/services";
import { verifyCodMessagingToken } from "@/server/cod-webhook";

/**
 * Delivery receipts of COD confirmation messages (C.17): the tenant's messaging channel verifies the
 * provider payload, the status moves forward on the matching message. Refused for tenants without
 * `addon.cod` (the add-on is unreachable even by URL).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string; token: string }> }) {
  const { tenantId, token } = await params;
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !verifyCodMessagingToken(tenantId, token)) return new NextResponse("not found", { status: 404 });
  const [addon] = await adminDb().select({ id: schema.tenantAddons.id }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, "addon.cod"), eq(schema.tenantAddons.isActive, true))).limit(1);
  if (!addon) return new NextResponse("not found", { status: 404 });
  const raw = await req.text();
  let receipt: { messageId: string; status: "sent" | "delivered" | "read" | "failed" };
  try {
    receipt = await getMessagingChannelFor(tenantId).verifyWebhook(Object.fromEntries(req.headers.entries()), raw);
  } catch {
    return new NextResponse("invalid payload", { status: 400 });
  }
  if (!receipt.messageId || !["sent", "delivered", "read", "failed"].includes(receipt.status)) return new NextResponse("invalid payload", { status: 400 });
  const updated = await withTenant(tenantId, (tx) => applyMessageStatus({ tenantId, tx, actor: { type: "integration", userId: null } }, receipt.messageId, receipt.status));
  return NextResponse.json({ ok: true, updated });
}
