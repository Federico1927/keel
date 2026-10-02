import { createHmac, timingSafeEqual } from "node:crypto";
import { apiEndpoint } from "@hullwise/config";

/**
 * Per-tenant secret token in the Spoki webhook URL (issue #9). Spoki signs nothing: the study of the
 * reference platform shows a shared secret only, so the URL carries an HMAC of the tenant id
 * (derived from APP_ENCRYPTION_KEY, nothing stored); a wrong token or tenant is a 404.
 */
export function spokiWebhookToken(tenantId: string): string {
  return createHmac("sha256", process.env.APP_ENCRYPTION_KEY ?? "hullwise-dev").update(`spoki-webhook:${tenantId}`).digest("hex").slice(0, 40);
}

export function verifySpokiWebhookToken(tenantId: string, token: string): boolean {
  const expected = Buffer.from(spokiWebhookToken(tenantId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function spokiWebhookUrl(tenantId: string): string {
  return apiEndpoint(`/webhooks/spoki/${tenantId}/${spokiWebhookToken(tenantId)}`);
}
