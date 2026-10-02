import { apiEndpoint, appUrl, setupCopyValues, type IntegrationSetupGuide } from "@hullwise/config";
import { SHOPIFY_OPTIONAL_SCOPES, SHOPIFY_REQUIRED_SCOPES } from "@hullwise/integrations";

/**
 * Copyable values of the setup definitions, resolved on the server (scope lists live in the adapters,
 * URLs depend on the deployment's hosts). A new provider adds its ids here.
 */
const RESOLVERS: Record<string, () => string> = {
  "shopify.scopes_required": () => SHOPIFY_REQUIRED_SCOPES.join(","),
  "shopify.scopes_optional": () => SHOPIFY_OPTIONAL_SCOPES.join(","),
  "shopify.redirect_url": () => apiEndpoint("/integrations/shopify/oauth/callback"),
  "shopify.app_url": () => appUrl(),
  "shopify.webhook_url": () => apiEndpoint("/webhooks/shopify"),
  "shopify.compliance_url": () => apiEndpoint("/webhooks/shopify/compliance"),
};

export function resolveSetupValues(guide: IntegrationSetupGuide): Record<string, string> {
  return Object.fromEntries(setupCopyValues(guide).flatMap((id) => {
    const r = RESOLVERS[`${guide.provider}.${id}`];
    return r ? [[id, r()]] : [];
  }));
}
