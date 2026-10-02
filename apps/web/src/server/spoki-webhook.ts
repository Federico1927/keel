import { createHmac, timingSafeEqual } from "node:crypto";
import { apiEndpoint } from "@hullwise/config";
import { encryptionKeyStrings } from "@hullwise/integrations";

/**
 * Per-tenant secret token in the Spoki webhook URL (issue #9). Spoki signs nothing: the study of the
 * reference platform shows a shared secret only, so the URL carries an HMAC of the tenant id
 * (derived from APP_ENCRYPTION_KEY, nothing stored); a wrong token or tenant is a 404.
 */
export function spokiWebhookToken(tenantId: string, secret = encryptionKeyStrings("hullwise-dev")[0]!): string {
  return createHmac("sha256", secret).update(`spoki-webhook:${tenantId}`).digest("hex").slice(0, 40);
}

/** During an APP_ENCRYPTION_KEY rotation the URL made with APP_ENCRYPTION_KEY_PREVIOUS keeps working until it is replaced. */
export function verifySpokiWebhookToken(tenantId: string, token: string): boolean {
  const given = Buffer.from(token);
  return encryptionKeyStrings("hullwise-dev").some((secret) => {
    const expected = Buffer.from(spokiWebhookToken(tenantId, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function spokiWebhookUrl(tenantId: string): string {
  return apiEndpoint(`/webhooks/spoki/${tenantId}/${spokiWebhookToken(tenantId)}`);
}
