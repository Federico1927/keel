import { and, eq, schema } from "@hullwise/db";
import { isAdPlatform } from "@hullwise/config";
import { adAccountsOverview, getAdsPlatformFor, getConversionSettings, getLlmProviderFor, getSubscriptionProviderFor, resolveAddressProvider, type PlatformTenant, type ServiceContext } from "@hullwise/services";
import { getSpokiApiFor, syncSpokiTemplates } from "@hullwise/addon-spoki";

/** What the last step of a setup shows: numbers and names the adapter returned (`IntegrationSetupGuide.verifiedKey`). */
export type SetupFacts = Record<string, string | number>;

/** A well-known address every validation provider can answer for, so the check costs one request and shows something real. */
const SAMPLE_ADDRESS = { name: "Test", address1: "1600 Amphitheatre Parkway", city: "Mountain View", province: "CA", zip: "94043", country: "US" };

/**
 * The verification step of the merchant self-setup (#90): after a connect or a successful test, read
 * real data through the tenant's adapter (the simulator in mock mode) and return what was found
 * (campaigns and accounts, the model that answered, templates, subscriptions…). Best effort: null when
 * the read fails, since the connection test itself already passed.
 */
export async function verifySetup(provider: string, s: ServiceContext, tenant: PlatformTenant): Promise<SetupFacts | null> {
  try {
    if (isAdPlatform(provider)) {
      const campaigns = await (await getAdsPlatformFor(s, tenant, provider)).fetchCampaigns();
      const facts: SetupFacts = { campaigns: campaigns.length, active: campaigns.filter((c) => c.status === "active").length };
      const [row] = await s.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, s.tenantId), eq(schema.integrations.provider, provider))).limit(1);
      if (provider === "meta") {
        const accounts = await adAccountsOverview(s, "meta");
        const pixel = (await getConversionSettings(s)).find((c) => c.provider === "meta")?.destinationId ?? null;
        return { ...facts, accounts: Math.max(1, accounts.length), names: accounts.length ? accounts.map((a) => a.name).join(", ") : (row?.externalAccountName ?? row?.externalAccountId ?? ""), pixel: pixel ?? "none" };
      }
      if (provider === "tiktok") return { ...facts, advertisers: ((row?.config ?? {}) as { advertiserIds?: string[] }).advertiserIds?.length ?? 1 };
      return { ...facts, account: row?.externalAccountName ?? row?.externalAccountId ?? "" };
    }
    if (provider === "anthropic") {
      const llm = await getLlmProviderFor(s);
      const test = llm ? await llm.testConnection() : null;
      return test?.ok ? { model: test.accountName ?? test.accountId ?? "" } : null;
    }
    if (provider === "address") {
      const p = await resolveAddressProvider(s);
      const v = await p.validate(SAMPLE_ADDRESS);
      const suggestions = await p.autocomplete(SAMPLE_ADDRESS.address1, { country: "US", limit: 3 });
      return { valid: v.valid ? "yes" : "no", suggestions: suggestions.length };
    }
    if (provider === "spoki") {
      const api = await getSpokiApiFor(s);
      return api ? await syncSpokiTemplates(s, api) : null;
    }
    if (provider === "recharge" || provider === "loop" || provider === "shopify_subscriptions") {
      const p = await getSubscriptionProviderFor(s);
      if (!p) return null;
      const page = await p.fetchContracts({ limit: 100 });
      return { contracts: page.items.length, more: page.nextCursor ? "yes" : "no" };
    }
    return null;
  } catch (e) {
    console.warn(`[setup] ${provider} verification read failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}
