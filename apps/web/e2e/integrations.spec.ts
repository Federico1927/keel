import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("integrations", () => {
  test("owner sees providers, tests the connection, simulates a webhook that becomes an order, and bad signatures are rejected", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Integrations|Integrazioni/);
    await expect(page.getByTestId("mock-banner")).toBeVisible();
    for (const p of ["shopify", "meta", "google"]) await expect(page.getByTestId(`provider-${p}`)).toBeVisible();
    await expect(page.getByText(/Available on request|Disponibile su richiesta/).first()).toBeVisible();

    const shopify = page.getByTestId("provider-shopify");
    await shopify.getByRole("button", { name: /Test connection|Testa connessione/ }).click();
    await expect(page.getByTestId("msg-shopify")).toContainText(/Connection OK|Connessione OK/);

    // mock-only simulations are in the card's "…" menu (#90)
    await shopify.getByTestId("shopify-simulate-menu").click();
    await page.getByRole("menuitem", { name: /Simulate order webhook|Simula webhook ordine/ }).click();
    await expect(page.getByTestId("msg-shopify")).toContainText(/HTTP 200/);
    const text = await page.getByTestId("msg-shopify").textContent();
    const orderName = /(#[A-Z0-9-]+)/.exec(text ?? "")?.[1];
    expect(orderName).toBeTruthy();
    await expect(page.getByTestId("webhook-row").first()).toContainText(/orders\/create/);
    await expect.poll(async () => {
      await page.goto(`/t/northwind-apparel/orders?q=${encodeURIComponent(orderName!)}`);
      return page.locator("table tbody tr").filter({ hasText: orderName! }).count();
    }, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.locator("table tbody tr").filter({ hasText: orderName! }).first().getByRole("link").first().click();
    await expect(page.getByText(/Imported|Importato/).first()).toBeVisible();

    await page.goto("/t/northwind-apparel/integrations");
    await page.getByTestId("provider-shopify").getByTestId("shopify-simulate-menu").click();
    await page.getByRole("menuitem", { name: /Simulate bad signature|Simula firma errata/ }).click();
    await expect(page.getByTestId("msg-shopify")).toContainText(/HTTP 401/);
    // Resync is in the card's Manage sheet
    await page.getByTestId("provider-meta").getByTestId("meta-manage").click();
    await page.getByTestId("integration-sheet").getByRole("button", { name: /^Resync$|^Risincronizza$/ }).click();
    await expect(page.getByTestId("msg-meta")).toContainText(/Resync|Risincronizzazione/);
  });

  test("webhook endpoint rejects unknown shops and bad signatures without a session", async ({ request }) => {
    const unknown = await request.post("/api/webhooks/shopify", { headers: { "x-shopify-shop-domain": "nobody.myshopify.com", "x-shopify-topic": "orders/create", "x-shopify-hmac-sha256": "x" }, data: { id: 1 } });
    expect(unknown.status()).toBe(404);
    const bad = await request.post("/api/webhooks/shopify", { headers: { "x-shopify-shop-domain": "northwind-demo.myshopify.com", "x-shopify-topic": "orders/create", "x-shopify-hmac-sha256": "x" }, data: { id: 1, updated_at: "2026-01-01T00:00:00Z" } });
    expect(bad.status()).toBe(401);
  });

  test("guides render in English and Italian with verification badges and scopes; non-admins cannot open integrations", async ({ page, browser }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations/guide/shopify");
    await expect(page.getByTestId("guide-step").first()).toBeVisible();
    expect(await page.getByTestId("guide-step").count()).toBeGreaterThanOrEqual(6);
    await expect(page.getByText(/To verify|Da verificare/).first()).toBeVisible();
    await expect(page.getByText("read_orders").first()).toBeVisible();
    await expect(page.getByText(/api\/webhooks\/shopify/).first()).toBeVisible();
    await page.goto("/t/northwind-apparel/integrations/guide/meta");
    await expect(page.getByText("ads_management").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/integrations/guide/google");
    await expect(page.getByTestId("guide-step").first()).toBeVisible();

    // a fresh context: clearing cookies races with session refreshes on the previous page
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await login(page2, "care@northwind.demo");
    const res = await page2.goto("/t/northwind-apparel/integrations");
    expect(res?.status()).toBe(404);
    await other.close();
  });
});
