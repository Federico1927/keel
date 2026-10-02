import { describe, expect, it } from "vitest";
import { INTEGRATION_SETUP } from "@hullwise/config";
import { MOCK_SETUP_TRIGGERS, mockGoogleAdsAccounts, simulateSetupCheck } from "./mock/setup";
import { addressSetupError, anthropicSetupError, classifySetupError, googleAdsSetupError, metaSetupError, setupErrorFromText, setupErrorOfTest, spokiSetupError, subscriptionSetupError, tiktokSetupError } from "./setup-errors";
import { googleAdsAccountOptions, googleAdsCredentials, googleOAuthAuthorizeUrl, listGoogleAdsAccounts } from "./google/oauth";
import { fixtureFetch } from "./http";
import { IntegrationError } from "./types";

/** Codes no simulated vendor answer produces: form validation, the owner's missing app, a pre-check on another connection, the fallback. */
const NOT_SIMULATED = new Set(["invalid_input", "unknown", "app_not_configured", "shopify_not_connected"]);

describe("setup error classifiers (#90)", () => {
  it("every mock trigger reaches the card as its mapped error, through the live classifier", () => {
    for (const [provider, triggers] of Object.entries(MOCK_SETUP_TRIGGERS)) {
      for (const t of triggers) {
        const failure = simulateSetupCheck(provider, { [t.field]: `x-${t.value}-y` });
        expect(failure, `${provider} ${t.value}`).toEqual(t.failure);
        expect(classifySetupError(provider, { code: failure!.errorCode, message: failure!.error, stage: failure!.stage }), `${provider} ${t.value}`).toBe(t.expect);
      }
    }
  });

  it("the mock simulates every error of every guide, and only codes the guide explains", () => {
    for (const [provider, triggers] of Object.entries(MOCK_SETUP_TRIGGERS)) {
      const guide = INTEGRATION_SETUP[provider];
      expect(guide, provider).toBeTruthy();
      const codes = Object.keys(guide!.errors);
      for (const t of triggers) expect(codes, `${provider} ${t.expect}`).toContain(t.expect);
      const simulated = new Set(triggers.map((t) => t.expect));
      const missing = codes.filter((c) => !NOT_SIMULATED.has(c) && !simulated.has(c));
      // Shopify Subscriptions has no typed value to trigger on: its errors come from the Shopify connection itself
      if (provider !== "shopify_subscriptions") expect(missing, provider).toEqual([]);
    }
  });

  it("values without a trigger pass the simulated check", () => {
    expect(simulateSetupCheck("meta", { accessToken: "EAAB-simulated-token-123", adAccountIds: "act_123456789", pixelId: "123456789" })).toBeNull();
    expect(simulateSetupCheck("unknown-provider", { apiKey: "invalid-key-demo" })).toBeNull();
  });

  it("Meta: the step that failed decides between account and pixel", () => {
    expect(metaSetupError({ code: "invalid_request", message: "Unsupported get request. Object with ID '123' does not exist", stage: "pixel" })).toBe("pixel_not_accessible");
    expect(metaSetupError({ code: "invalid_request", message: "Unsupported get request. Object with ID 'act_9' does not exist, cannot be loaded due to missing permissions", stage: "account" })).toBe("account_not_assigned");
    // an expired token stays an expired token whatever the step
    expect(metaSetupError({ code: "token_expired", message: "Error validating access token", stage: "pixel" })).toBe("invalid_token");
    expect(metaSetupError({ message: "Invalid OAuth access token - Cannot parse access token" })).toBe("invalid_token");
    expect(metaSetupError({ code: "permission", message: "(#10) Not enough permission to call this API" })).toBe("missing_permission");
    expect(metaSetupError({ message: "something else" })).toBe("unknown");
  });

  it("Google Ads, TikTok, Anthropic, address, Spoki and subscription apps read the vendor's words", () => {
    expect(googleAdsSetupError({ code: "permission", message: "HTTP 403: {\"error\":{\"details\":[{\"errors\":[{\"errorCode\":{\"authorizationError\":\"DEVELOPER_TOKEN_NOT_APPROVED\"}}]}]}}" })).toBe("developer_token");
    expect(googleAdsSetupError({ code: "access_denied" })).toBe("access_denied");
    expect(googleAdsSetupError({ code: "app_not_configured" })).toBe("app_not_configured");
    expect(tiktokSetupError({ code: "token_expired", message: "The access token is invalid or has been revoked." })).toBe("token_expired");
    expect(anthropicSetupError({ message: "auth: 401 invalid x-api-key" })).toBe("invalid_key");
    expect(anthropicSetupError({ message: "bad_request: Your credit balance is too low to access the Anthropic API." })).toBe("no_credit");
    // "Billing is not enabled" must not read as "API not enabled"
    expect(addressSetupError({ code: "permission", message: "Billing is not enabled on the Google Cloud project (BILLING_DISABLED)" })).toBe("billing_disabled");
    expect(addressSetupError({ code: "permission", message: "HTTP 403: Requests to this API addressvalidation.googleapis.com method are blocked. API_KEY_SERVICE_BLOCKED" })).toBe("key_restricted");
    expect(spokiSetupError({ code: "token_expired", message: "HTTP 401" })).toBe("invalid_key");
    expect(subscriptionSetupError({ code: "shopify_not_connected" })).toBe("shopify_not_connected");
    expect(subscriptionSetupError({ message: "Missing scopes: read_own_subscription_contracts" })).toBe("missing_scopes");
  });

  it("reads tests and stored last errors, and ignores providers without a guide", () => {
    expect(setupErrorOfTest("meta", { error: "(#17) User request limit reached", errorCode: "rate_limited" })).toBe("rate_limited");
    expect(setupErrorFromText("address", "[permission] The Address Validation API or Places API (New) is not enabled on the Google Cloud project (SERVICE_DISABLED)")).toBe("api_not_enabled");
    expect(setupErrorFromText("spoki", "HTTP 401: Invalid API key.")).toBe("invalid_key");
    expect(setupErrorFromText("meta", null)).toBeNull();
    expect(classifySetupError("shopify", { message: "x" })).toBeNull();
  });
});

describe("Google Ads sign-in (#90)", () => {
  it("offers plain accounts directly and a manager's open client accounts through the manager, each once", () => {
    const options = googleAdsAccountOptions([
      { rootId: "100", rows: [{ customerClient: { id: "100", descriptiveName: "Shop", manager: false, level: 0, currencyCode: "EUR" } }] },
      {
        rootId: "900",
        rows: [
          { customerClient: { id: "900", descriptiveName: "Agency MCC", manager: true, level: 0 } },
          { customerClient: { id: "100", descriptiveName: "Shop", manager: false, level: 1, status: "ENABLED" } },
          { customerClient: { id: "200", descriptiveName: "Shop US", manager: false, level: 1, status: "ENABLED", currencyCode: "USD" } },
          { customerClient: { id: "300", descriptiveName: "Old shop", manager: false, level: 1, status: "CANCELED" } },
          { customerClient: { id: "950", descriptiveName: "Sub manager", manager: true, level: 1, status: "ENABLED" } },
        ],
      },
    ]);
    expect(options).toEqual([
      { customerId: "100", name: "Shop", loginCustomerId: null, managerName: null, currency: "EUR" },
      { customerId: "200", name: "Shop US", loginCustomerId: "900", managerName: "Agency MCC", currency: "USD" },
    ]);
  });

  it("lists the accounts of the signed-in user, and explains a refusal of every root", async () => {
    const ok = fixtureFetch([
      { match: (u) => u.endsWith("customers:listAccessibleCustomers"), body: { resourceNames: ["customers/100", "customers/900"] } },
      { match: (u) => u.includes("/customers/100/"), body: [{ results: [{ customerClient: { id: "100", descriptiveName: "Shop", manager: false, level: 0 } }] }] },
      { match: (u) => u.includes("/customers/900/"), status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission", details: [{ errors: [{ errorCode: { authorizationError: "CUSTOMER_NOT_ENABLED" } }] }] } } },
    ]);
    const list = await listGoogleAdsAccounts({ accessToken: "ya29.x", developerToken: "dev" }, { fetchImpl: ok, sleep: async () => undefined, minIntervalMs: 0 });
    expect(list.map((a) => a.customerId)).toEqual(["100"]);
    const none = fixtureFetch([{ match: () => true, body: { resourceNames: [] } }]);
    const err = await listGoogleAdsAccounts({ accessToken: "ya29.x", developerToken: "dev" }, { fetchImpl: none, sleep: async () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(googleAdsSetupError({ code: (err as IntegrationError).code, message: (err as IntegrationError).message })).toBe("no_accounts");
  });

  it("builds the consent URL with offline access, and completes stored credentials with the platform's app", () => {
    const u = new URL(googleOAuthAuthorizeUrl({ clientId: "cid", redirectUri: "https://api.example.com/integrations/google/oauth/callback", state: "s1" }));
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    const env = { HULLWISE_GOOGLE_ADS_CLIENT_ID: "cid", HULLWISE_GOOGLE_ADS_CLIENT_SECRET: "sec", HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN: "dev" };
    expect(googleAdsCredentials({ refreshToken: "r", customerId: "100", loginCustomerId: "900", app: "platform" }, env)).toMatchObject({ clientId: "cid", clientSecret: "sec", developerToken: "dev", refreshToken: "r", loginCustomerId: "900" });
    expect(() => googleAdsCredentials({ refreshToken: "r", customerId: "100" }, {})).toThrow(IntegrationError);
    // the store's own app (manual path) needs nothing from the platform
    expect(googleAdsCredentials({ refreshToken: "r", customerId: "100", clientId: "own", clientSecret: "own-s", developerToken: "own-d" }, {}).clientId).toBe("own");
  });

  it("the simulated sign-in offers accounts that trigger each account error", () => {
    const accounts = mockGoogleAdsAccounts("Harbor Home", "USD");
    const outcomes = accounts.map((a) => simulateSetupCheck("google", { customerId: a.customerId }));
    expect(outcomes.filter((o) => o === null).length).toBeGreaterThanOrEqual(2);
    expect(accounts.some((a) => a.loginCustomerId)).toBe(true);
    expect(new Set(outcomes.filter(Boolean).map((o) => googleAdsSetupError({ code: o!.errorCode, message: o!.error })))).toEqual(new Set(["not_enabled", "developer_token", "no_permission"]));
  });
});
