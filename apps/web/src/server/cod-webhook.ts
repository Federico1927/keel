import { createHmac, timingSafeEqual } from "node:crypto";
import { apiEndpoint } from "@hullwise/config";
import { encryptionKeyStrings } from "@hullwise/integrations";

/**
 * Per-tenant token in the COD messaging webhook URL (C.17). The channel's own `verifyWebhook` checks
 * the provider signature; the token keeps a guessed tenant id from posting receipts to another tenant
 * (the mock channel has no signature at all).
 */
export function codMessagingToken(tenantId: string, secret = encryptionKeyStrings("hullwise-dev")[0]!): string {
  return createHmac("sha256", secret).update(`cod-messaging:${tenantId}`).digest("hex").slice(0, 40);
}

/** During an APP_ENCRYPTION_KEY rotation the URL made with APP_ENCRYPTION_KEY_PREVIOUS keeps working until it is replaced. */
export function verifyCodMessagingToken(tenantId: string, token: string): boolean {
  const given = Buffer.from(token);
  return encryptionKeyStrings("hullwise-dev").some((secret) => {
    const expected = Buffer.from(codMessagingToken(tenantId, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function codMessagingWebhookUrl(tenantId: string): string {
  return apiEndpoint(`/webhooks/cod-messaging/${tenantId}/${codMessagingToken(tenantId)}`);
}
