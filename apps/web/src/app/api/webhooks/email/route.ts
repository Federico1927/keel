import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withTenant } from "@keel/db";
import { parseEmailDeliveryEvent } from "@keel/integrations";
import { addEmailSuppression } from "@keel/services";

/**
 * Bounce and complaint events from the email provider feed the suppression list of the tenant the
 * message was tagged with. Authenticated with a shared secret in the URL (`?token=`, set as
 * KEEL_EMAIL_WEBHOOK_SECRET); provider-specific signature checks are to verify on the chosen provider.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.KEEL_EMAIL_WEBHOOK_SECRET;
  const given = req.nextUrl.searchParams.get("token") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return new NextResponse("unauthorized", { status: 401 });
  const event = parseEmailDeliveryEvent(await req.json().catch(() => null));
  if (!event?.tenantId) return NextResponse.json({ ignored: true });
  const tenantId = event.tenantId;
  await withTenant(tenantId, async (tx) => {
    for (const email of event.emails) await addEmailSuppression({ tenantId, tx, actor: { type: "system", userId: null } }, { email, reason: event.kind, source: "provider" });
  });
  return NextResponse.json({ suppressed: event.emails.length });
}
