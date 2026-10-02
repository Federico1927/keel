import { createHmac, timingSafeEqual } from "node:crypto";
import { apiEndpoint } from "@hullwise/config";

/**
 * Per-tenant token in the COD messaging webhook URL (C.17). The channel's own `verifyWebhook` checks
 * the provider signature; the token keeps a guessed tenant id from posting receipts to another tenant
 * (the mock channel has no signature at all).
 */
export function codMessagingToken(tenantId: string): string {
  return createHmac("sha256", process.env.APP_ENCRYPTION_KEY ?? "hullwise-dev").update(`cod-messaging:${tenantId}`).digest("hex").slice(0, 40);
}

export function verifyCodMessagingToken(tenantId: string, token: string): boolean {
  const expected = Buffer.from(codMessagingToken(tenantId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function codMessagingWebhookUrl(tenantId: string): string {
  return apiEndpoint(`/webhooks/cod-messaging/${tenantId}/${codMessagingToken(tenantId)}`);
}
