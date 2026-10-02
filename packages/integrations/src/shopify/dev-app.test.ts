import { describe, expect, it } from "vitest";
import { HttpClient, fixtureFetch } from "../http";
import { signState, verifyState } from "../crypto";
import { ShopifyCommercePlatform, type ShopifyCredentials } from "./adapter";
import { SHOPIFY_API_VERSION, SHOPIFY_OPTIONAL_SCOPES, SHOPIFY_REQUIRED_SCOPES, ShopifyGrantError, classifyGrantFailure, missingShopifyScopes, requestClientCredentialsToken } from "./oauth";
import { graphqlShop, graphqlWebhookCreate, graphqlWebhooks } from "./__fixtures__";

process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const shop = "my-dev-store.myshopify.com";
const http = (routes: Parameters<typeof fixtureFetch>[0]) => new HttpClient({ fetchImpl: fixtureFetch(routes), sleep: async () => undefined });
const tokenUrl = (u: string) => u === `https://${shop}/admin/oauth/access_token`;
const NOW = Date.parse("2026-10-02T12:00:00Z");

describe("Dev Dashboard app: client credentials grant (issue #89)", () => {
  it("posts the form-encoded grant and reads token, scopes and expiry", async () => {
    const h = http([{ match: tokenUrl, body: { access_token: "tok-1", scope: "read_orders,write_products", expires_in: 86399 } }]);
    const t = await requestClientCredentialsToken(shop, "cid", "csecret", h, () => NOW);
    expect(t).toEqual({ accessToken: "tok-1", scopes: ["read_orders", "write_products"], expiresAt: new Date(NOW + 86_399_000).toISOString() });
    expect(h.calls[0]!.method).toBe("POST");
    expect(new URLSearchParams(h.calls[0]!.body)).toEqual(new URLSearchParams({ grant_type: "client_credentials", client_id: "cid", client_secret: "csecret" }));
  });

  it("explains a refusal: store outside the app's organization, wrong secret, unknown shop", async () => {
    const outside = http([{ match: tokenUrl, status: 400, body: { error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." } }]);
    await expect(requestClientCredentialsToken(shop, "cid", "s", outside)).rejects.toMatchObject({ reason: "not_in_organization" });
    const wrong = http([{ match: tokenUrl, status: 401, body: { error: "invalid_client" } }]);
    const e = await requestClientCredentialsToken(shop, "cid", "bad", wrong).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ShopifyGrantError);
    expect((e as ShopifyGrantError).reason).toBe("wrong_credentials");
    expect(classifyGrantFailure(404, "Not Found")).toBe("shop_not_found");
    expect(classifyGrantFailure(400, "app_not_installed")).toBe("not_installed");
  });

  it("renews a token close to its expiry before the call, and keeps the new one", async () => {
    let n = 0;
    const seen: string[] = [];
    const refreshed: ShopifyCredentials[] = [];
    const creds: ShopifyCredentials = { shop, clientId: "cid", apiSecret: "csecret", accessToken: "old", grant: "client_credentials", expiresAt: new Date(NOW + 60_000).toISOString() };
    const p = new ShopifyCommercePlatform(creds, { now: () => NOW, minIntervalMs: 0, sleep: async () => undefined, onCredentialsRefreshed: (c) => void refreshed.push(c), fetchImpl: fixtureFetch([{ match: tokenUrl, body: () => ({ access_token: `new-${++n}`, scope: "read_orders", expires_in: 86399 }) }, { match: (u) => u.includes(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`), body: () => graphqlShop }]) });
    const orig = p.http.request.bind(p.http);
    p.http.request = (async (url: string, init: { headers?: Record<string, string> } = {}) => {
      if (init.headers?.["x-shopify-access-token"]) seen.push(init.headers["x-shopify-access-token"]);
      return orig(url, init as never);
    }) as typeof p.http.request;
    expect((await p.testConnection()).ok).toBe(true);
    await p.testConnection();
    expect(n).toBe(1);
    expect(seen).toEqual(["new-1", "new-1"]);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.accessToken).toBe("new-1");
    expect(p.credentials.expiresAt).toBe(new Date(NOW + 86_399_000).toISOString());
  });

  it("on a 401 renews once and retries; a second 401 is token_expired", async () => {
    const creds: ShopifyCredentials = { shop, clientId: "cid", apiSecret: "csecret", accessToken: "revoked", grant: "client_credentials", expiresAt: null };
    let gql = 0;
    const p = new ShopifyCommercePlatform(creds, { minIntervalMs: 0, sleep: async () => undefined, fetchImpl: async (url, init) => {
      if (tokenUrl(url)) return fixtureFetch([{ match: () => true, body: { access_token: "fresh", scope: "read_orders", expires_in: 86399 } }])(url, init);
      gql++;
      const ok = init?.headers?.["x-shopify-access-token"] === "fresh";
      return fixtureFetch([{ match: () => true, status: ok ? 200 : 401, body: ok ? graphqlShop : { errors: "Invalid API key or access token" } }])(url, init);
    } });
    expect((await p.testConnection()).ok).toBe(true);
    expect(gql).toBe(2);
    const dead = new ShopifyCommercePlatform(creds, { minIntervalMs: 0, sleep: async () => undefined, fetchImpl: fixtureFetch([{ match: tokenUrl, body: { access_token: "also-revoked", scope: "", expires_in: 86399 } }, { match: () => true, status: 401, body: { errors: "Invalid API key or access token" } }]) });
    await expect(dead.fetchLocations()).rejects.toMatchObject({ code: "token_expired", message: expect.stringContaining("renewed token") });
    const legacy = new ShopifyCommercePlatform({ shop, accessToken: "shpat_x", apiSecret: "s" }, { minIntervalMs: 0, sleep: async () => undefined, fetchImpl: fixtureFetch([{ match: () => true, status: 401, body: { errors: "Invalid API key or access token" } }]) });
    await expect(legacy.fetchLocations()).rejects.toMatchObject({ code: "token_expired" });
    expect(legacy.http.calls).toHaveLength(1);
  });

  it("a refresh Shopify refuses is reported as a token refresh failure", async () => {
    const creds: ShopifyCredentials = { shop, clientId: "cid", apiSecret: "rotated", accessToken: "old", grant: "client_credentials", expiresAt: new Date(NOW - 1000).toISOString() };
    const p = new ShopifyCommercePlatform(creds, { now: () => NOW, minIntervalMs: 0, sleep: async () => undefined, fetchImpl: fixtureFetch([{ match: tokenUrl, status: 401, body: { error: "invalid_client" } }]) });
    await expect(p.fetchLocations()).rejects.toMatchObject({ code: "token_expired", message: expect.stringContaining("token refresh failed") });
  });

  it("test connection lists the missing scopes, required apart, and per module", async () => {
    const p = new ShopifyCommercePlatform({ shop, accessToken: "t", apiSecret: "s" }, { minIntervalMs: 0, sleep: async () => undefined, fetchImpl: fixtureFetch([{ match: () => true, body: graphqlShop }]) });
    const t = await p.testConnection();
    expect(t.missingRequiredScopes).toEqual(expect.arrayContaining(["read_publications", "read_merchant_managed_fulfillment_orders"]));
    expect(t.missingRequiredScopes).not.toContain("read_returns");
    expect(t.missingScopesByModule!["core.returns"]).toEqual(["read_returns", "write_returns"]);
    expect(t.missingScopesByModule!["core.discounts"]).toBeUndefined();
    const all = missingShopifyScopes([...SHOPIFY_REQUIRED_SCOPES, ...SHOPIFY_OPTIONAL_SCOPES]);
    expect(all).toEqual({ required: [], optional: [], byModule: {} });
    // a write scope covers its read scope
    expect(missingShopifyScopes(["write_orders"]).required).not.toContain("read_orders");
  });

  it("registers webhooks with `uri` and skips topics already pointing at it", async () => {
    const p = new ShopifyCommercePlatform({ shop, accessToken: "t", apiSecret: "s" }, { minIntervalMs: 0, sleep: async () => undefined, fetchImpl: fixtureFetch([{ match: (_u, i) => (i?.body ?? "").includes("webhookSubscriptions(first"), body: graphqlWebhooks }, { match: (_u, i) => (i?.body ?? "").includes("webhookSubscriptionCreate"), body: graphqlWebhookCreate }]) });
    const r = await p.registerWebhooks("https://hullwise.example/api/webhooks/shopify", ["orders/create", "app/uninstalled"]);
    expect(r.map((x) => x.status)).toEqual(["existing", "registered"]);
    const sent = JSON.parse(p.http.calls[1]!.body!) as { variables: { topic: string; sub: Record<string, unknown> } };
    expect(sent.variables).toEqual({ topic: "APP_UNINSTALLED", sub: { uri: "https://hullwise.example/api/webhooks/shopify", format: "JSON" } });
  });
});

describe("signed OAuth state", () => {
  it("round-trips, expires and rejects tampering", () => {
    const s = signState({ t: "tenant-1", shop }, 600, NOW);
    expect(verifyState<{ t: string; shop: string }>(s, NOW + 1000)).toMatchObject({ t: "tenant-1", shop });
    expect(verifyState(s, NOW + 601_000)).toBeNull();
    const [body, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ t: "tenant-2", shop, exp: NOW / 1000 + 600, n: "x" })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, NOW)).toBeNull();
    expect(verifyState(`${body}.x${sig!.slice(1)}`, NOW)).toBeNull();
    expect(verifyState("garbage", NOW)).toBeNull();
  });
});
