import { NextResponse, after, type NextRequest } from "next/server";
import { adminDb, and, eq, schema, withTenant } from "@hullwise/db";
import { SPOKI_MODULE, recordSpokiWebhook } from "@hullwise/addon-spoki";
import { handleSpokiEvent } from "@hullwise/jobs";
import { enqueue } from "@/server/jobs";
import { verifySpokiWebhookToken } from "@/server/spoki-webhook";

/**
 * Spoki webhook (issue #9): message receipts (sent, delivered, read, failed), customer replies and
 * opt-outs. The per-tenant token in the URL is the shared secret; a tenant without
 * `addon.whatsapp_spoki` gets a 404 (unreachable even by URL). The event is stored once (message id
 * + status: a replay is a no-op), answered 200 at once and processed in the background (queue, or
 * inline after the response when no worker runs); failures are retried by the `whatsapp` tick.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string; token: string }> }) {
  const { tenantId, token } = await params;
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !verifySpokiWebhookToken(tenantId, token)) return new NextResponse("not found", { status: 404 });
  const [addon] = await adminDb().select({ id: schema.tenantAddons.id }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, SPOKI_MODULE), eq(schema.tenantAddons.isActive, true))).limit(1);
  if (!addon) return new NextResponse("not found", { status: 404 });
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return new NextResponse("invalid payload", { status: 400 });
  }
  const recorded = await withTenant(tenantId, (tx) => recordSpokiWebhook({ tenantId, tx, actor: { type: "integration", userId: null } }, body));
  if (recorded.ignored) return NextResponse.json({ ok: true, ignored: true });
  if (recorded.duplicate || !recorded.id) return NextResponse.json({ ok: true, duplicate: true });
  const eventId = recorded.id;
  after(async () => {
    if (!(await enqueue("webhook.process", { tenantId, eventId, source: "spoki" }))) await handleSpokiEvent(tenantId, eventId).catch((e: unknown) => console.warn("[spoki] webhook processing failed, the retry tick takes over:", e instanceof Error ? e.message : e));
  });
  return NextResponse.json({ ok: true, id: eventId });
}
