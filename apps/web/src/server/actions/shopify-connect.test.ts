import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Integrations from "@hullwise/integrations";

/**
 * Every Shopify connect path (#89: client credentials, per-tenant OAuth, mock; the legacy pasted token)
 * starts the history import (#87) exactly once, through the same entry point, and only when the store
 * is really connected. No database and no network: the session, the connection writer and the vendor
 * calls are replaced by stubs.
 */
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");

const h = vi.hoisted(() => ({
  startHistoryImport: vi.fn(async () => "queued"),
  saveShopifyConnection: vi.fn(async () => undefined),
  grant: vi.fn(),
  exchange: vi.fn(),
  test: vi.fn(),
  app: null as null | { shop: string; clientId: string; secretEncrypted: string },
  /** What the callback's tenant transaction answers (tenant row + saved app); null = run the query on the stub. */
  tenantRead: null as unknown,
}));

// a chainable, awaitable stand-in for a Drizzle transaction (every query resolves to no rows)
const chain: unknown = new Proxy(function () {}, { get: (_t, p) => (p === "then" ? (res: (v: unknown) => void) => res([]) : chain), apply: () => chain });
const ctx = { tenant: { id: "00000000-0000-4000-8000-000000000001", slug: "acme", country: "IT", currency: "EUR", orderNumberPrefix: "AC", timezone: "Europe/Rome" }, user: { id: "u1" }, impersonation: null, settings: { historyImportMonths: 24 }, run: (fn: (tx: unknown) => unknown) => fn(chain) };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/tenant", () => ({ ForbiddenError: class ForbiddenError extends Error {}, requireAction: vi.fn(async () => ctx) }));
vi.mock("@/server/history-import", () => ({ startHistoryImport: h.startHistoryImport }));
vi.mock("@/server/shopify-connection", () => ({ saveShopifyConnection: h.saveShopifyConnection, savedShopifyApp: () => h.app }));
vi.mock("@hullwise/db", async (orig) => ({ ...(await orig<object>()), recordAudit: vi.fn(async () => undefined), withTenant: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) => h.tenantRead ?? fn(chain)) }));
vi.mock("@hullwise/integrations", async (orig) => {
  const real = await orig<typeof Integrations>();
  class FakeShopify {
    constructor(public credentials: unknown) {}
    testConnection = () => h.test();
    registerWebhooks = async () => [];
  }
  return { ...real, ShopifyCommercePlatform: FakeShopify, requestClientCredentialsToken: (...a: unknown[]) => h.grant(...a), exchangeOAuthCode: (...a: unknown[]) => h.exchange(...a) };
});

const { SHOPIFY_ALL_SCOPES, ShopifyGrantError, encryptJson, signState } = await import("@hullwise/integrations");
const { connectShopifyApp, connectShopifyCustomApp } = await import("./shopify");
const callback = await import("@/app/api/integrations/shopify/oauth/callback/route");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const app = { shop: "acme.myshopify.com", clientId: "client-id-123", clientSecret: "client-secret-456" };
const fullTest = { ok: true, accountName: "Acme", scopes: SHOPIFY_ALL_SCOPES, missingScopes: [], missingRequiredScopes: [] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HULLWISE_INTEGRATION_MODE = "live";
  h.test.mockResolvedValue(fullTest);
  h.tenantRead = null;
  h.grant.mockResolvedValue({ accessToken: "tok", scopes: SHOPIFY_ALL_SCOPES, expiresAt: new Date(Date.now() + 864e5).toISOString() });
});

describe("each Shopify connect path starts the history import once", () => {
  it("client credentials (Dev Dashboard app in the store's organization)", async () => {
    const r = await connectShopifyApp("acme", null, form(app));
    expect(r).toMatchObject({ ok: true, data: { mock: false, shop: "acme.myshopify.com", history: "queued" } });
    expect(h.saveShopifyConnection).toHaveBeenCalledTimes(1);
    expect(h.saveShopifyConnection.mock.calls[0]![2]).toMatchObject({ mode: "live", config: { installedVia: "client_credentials" }, credentials: { grant: "client_credentials", clientId: "client-id-123", apiSecret: "client-secret-456", accessToken: "tok" } });
    expect(h.startHistoryImport).toHaveBeenCalledTimes(1);
    expect(h.startHistoryImport).toHaveBeenCalledWith(ctx);
  });

  it("a refused grant connects nothing and starts nothing: outside the organization → install fallback", async () => {
    h.grant.mockRejectedValue(new ShopifyGrantError("not_in_organization", "shop_not_permitted: Client credentials cannot be performed on this shop."));
    expect(await connectShopifyApp("acme", null, form(app))).toMatchObject({ ok: false, error: "not_in_organization" });
    h.grant.mockRejectedValue(new ShopifyGrantError("wrong_credentials", "invalid_client"));
    expect(await connectShopifyApp("acme", null, form(app))).toMatchObject({ ok: false, error: "wrong_credentials" });
    h.grant.mockResolvedValue({ accessToken: "tok", scopes: [], expiresAt: null });
    expect(await connectShopifyApp("acme", null, form(app))).toMatchObject({ ok: false, error: "version_not_released" });
    h.grant.mockResolvedValue({ accessToken: "tok", scopes: ["read_products"], expiresAt: null });
    h.test.mockResolvedValue({ ...fullTest, missingRequiredScopes: ["read_orders"] });
    expect(await connectShopifyApp("acme", null, form(app))).toMatchObject({ ok: false, error: "missing_scopes", fieldErrors: { scopes: "read_orders" } });
    expect(await connectShopifyApp("acme", null, form({ ...app, shop: "acme.com" }))).toMatchObject({ ok: false, error: "invalid_input", fieldErrors: { field: "shop" } });
    expect(h.saveShopifyConnection).not.toHaveBeenCalled();
    expect(h.startHistoryImport).not.toHaveBeenCalled();
  });

  it("mock mode: the simulated store connects and the import starts; the missing-scopes affordance does not", async () => {
    process.env.HULLWISE_INTEGRATION_MODE = "mock";
    expect(await connectShopifyApp("acme", null, form(app))).toMatchObject({ ok: true, data: { mock: true, shop: "mock-acme.myshopify.com" } });
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.startHistoryImport).toHaveBeenCalledTimes(1);
    expect(await connectShopifyApp("acme", null, form({ ...app, clientId: "missing-scopes-demo" }))).toMatchObject({ ok: false, error: "missing_scopes" });
    expect(h.startHistoryImport).toHaveBeenCalledTimes(1);
  });

  it("legacy pasted token (custom app created before 2026)", async () => {
    expect(await connectShopifyCustomApp("acme", null, form({ shop: "acme.myshopify.com", accessToken: "shpat_0123456789", apiSecret: "secret-123" }))).toMatchObject({ ok: true });
    expect(h.saveShopifyConnection.mock.calls[0]![2]).toMatchObject({ config: { installedVia: "custom_app" }, credentials: { grant: "static" } });
    expect(h.startHistoryImport).toHaveBeenCalledTimes(1);
  });

  it("per-tenant OAuth callback: signed state, query HMAC with the tenant's secret, code exchange", async () => {
    h.app = { shop: app.shop, clientId: app.clientId, secretEncrypted: encryptJson({ clientSecret: app.clientSecret }) };
    h.exchange.mockResolvedValue({ accessToken: "offline", scopes: SHOPIFY_ALL_SCOPES, expiresAt: null });
    h.tenantRead = { id: ctx.tenant.id, app: h.app };
    const state = signState({ t: ctx.tenant.id, s: "acme", u: "u1", shop: app.shop, app: "tenant" }, 600);
    const q: Record<string, string> = { code: "abc", shop: app.shop, state, timestamp: "1759400000" };
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&");
    const url = (hmac: string) => new URL(`https://api.example/api/integrations/shopify/oauth/callback?${new URLSearchParams({ ...q, hmac })}`);
    const req = (u: URL) => ({ nextUrl: u }) as never;
    const bad = await callback.GET(req(url("0".repeat(64))));
    expect(bad.headers.get("location")).toContain("shopify_error=wrong_credentials");
    expect(h.startHistoryImport).not.toHaveBeenCalled();
    const good = await callback.GET(req(url(createHmac("sha256", app.clientSecret).update(msg).digest("hex"))));
    expect(good.headers.get("location")).toContain("/t/acme/integrations?connected=shopify");
    expect(h.exchange).toHaveBeenCalledWith(app.shop, app.clientId, app.clientSecret, "abc");
    expect(h.saveShopifyConnection.mock.calls[0]![2]).toMatchObject({ config: { installedVia: "oauth_own_app" }, credentials: { grant: "authorization_code", accessToken: "offline", apiSecret: app.clientSecret } });
    expect(h.startHistoryImport).toHaveBeenCalledTimes(1);
    // a forged or expired state never reaches a tenant
    const forged = await callback.GET(req(new URL(`https://api.example/x?${new URLSearchParams({ ...q, state: "x.y", hmac: "z" })}`)));
    expect(forged.status).toBe(401);
  });
});
