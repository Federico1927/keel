import { NextResponse, after, type NextRequest } from "next/server";
import { adminDb } from "@keel/db";
import { processBillingEvent, receiveStripeWebhook } from "@keel/services";
import { enqueue } from "@/server/jobs";

/**
 * Stripe webhooks (#53), handled like the Shopify and email ones: Stripe-Signature checked with
 * STRIPE_WEBHOOK_SECRET (HMAC-SHA256, 5-minute tolerance), the event stored once (unique on its
 * id, so a redelivery is a no-op), 200 at once, processing in the background (queue, or inline
 * after the response when no worker runs). A bad signature is a 400, logged without the body.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return new NextResponse("stripe webhooks not configured", { status: 503 });
  const rawBody = await req.text();
  const r = await receiveStripeWebhook(adminDb(), { rawBody, signature: req.headers.get("stripe-signature"), secret, ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null });
  if (!r.ok) return new NextResponse(r.reason === "invalid_payload" ? "invalid payload" : "invalid signature", { status: 400 });
  if (r.duplicate || r.ignored || !r.id) return NextResponse.json({ ok: true, duplicate: r.duplicate, ignored: r.ignored });
  const id = r.id;
  after(async () => {
    if (!(await enqueue("billing.event", { eventId: id }))) await processBillingEvent(adminDb(), id);
  });
  return NextResponse.json({ ok: true, id });
}
