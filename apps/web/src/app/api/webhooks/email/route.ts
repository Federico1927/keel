import { NextResponse, after, type NextRequest } from "next/server";
import { adminDb } from "@hullwise/db";
import { parseResendEvent, verifySvixSignature } from "@hullwise/integrations";
import { processEmailEvent, recordEmailEvent } from "@hullwise/services";
import { enqueue } from "@/server/jobs";

/**
 * Resend delivery webhooks (delivered, bounced, complained, …), handled like the Shopify ones:
 * Svix signature check with RESEND_WEBHOOK_SECRET, the event stored once (unique on its id, so a
 * redelivery is a no-op), 200 at once, processing in the background (queue, or inline after the
 * response when no worker is around). Hard bounces and complaints feed the platform suppression list.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new NextResponse("email webhooks not configured", { status: 503 });
  const rawBody = await req.text();
  const eventId = verifySvixSignature(Object.fromEntries(req.headers.entries()), rawBody, secret);
  if (!eventId) return new NextResponse("invalid signature", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("invalid payload", { status: 400 });
  }
  const event = parseResendEvent(payload);
  if (!event) return NextResponse.json({ ignored: true });
  const recorded = await recordEmailEvent(adminDb(), { provider: "resend", eventId, event });
  if (recorded.duplicate || recorded.ignored || !recorded.id) return NextResponse.json({ ok: true, duplicate: recorded.duplicate });
  const id = recorded.id;
  after(async () => {
    if (!(await enqueue("email.event", { eventId: id }))) await processEmailEvent(adminDb(), id);
  });
  return NextResponse.json({ ok: true, id });
}
