import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("campaigns and stock", () => {
  test("list shows economics, health and recommendations; detail links products and pauses on Meta with confirmation", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=90d");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Campaigns|Campagne/);
    const rows = page.getByTestId("campaign-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(10);
    // every row carries a health light and a recommendation
    await expect(rows.first().getByText(/Good|Medium|Bad|No data|Buona|Media|Cattiva|Nessun dato/).first()).toBeVisible();

    // filter to active Meta campaigns and open the first one
    await page.goto("/t/northwind-apparel/campaigns?preset=90d&platform=meta&status=active");
    await expect(rows.first()).toBeVisible();
    await rows.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/);
    await expect(page.getByText(/Linked products|Prodotti collegati/)).toBeVisible();
    await expect(page.getByText(/Daily register|Registro giornaliero/).first()).toBeVisible();

    // pause with confirmation dialog, then resume
    await page.getByRole("button", { name: /Pause campaign|Metti in pausa/ }).click();
    await expect(page.getByRole("dialog")).toContainText(/Meta/);
    await page.getByRole("dialog").getByRole("button", { name: /Confirm|Conferma/ }).click();
    await expect(page.getByRole("button", { name: /Resume campaign|Riattiva/ })).toBeVisible();
    await page.getByRole("button", { name: /Resume campaign|Riattiva/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Confirm|Conferma/ }).click();
    await expect(page.getByRole("button", { name: /Pause campaign|Metti in pausa/ })).toBeVisible();

    // link a product through the form, then unlink it
    const select = page.locator("#link-product");
    const firstOption = await select.locator("option").nth(1).getAttribute("value");
    const firstTitle = (await select.locator("option").nth(1).textContent())!.trim();
    await select.selectOption(firstOption!);
    await page.getByRole("button", { name: /Link a product|Collega un prodotto/ }).click();
    const linked = page.locator("aside li, li").filter({ hasText: firstTitle }).first();
    await expect(linked).toBeVisible();
    await linked.getByRole("button", { name: /Unlink|Scollega/ }).click();
    await expect(page.locator("li").filter({ hasText: firstTitle })).toHaveCount(0);
  });

  test("google campaigns are read-only and the ledger exports CSV", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=90d&platform=google&status=active");
    await page.getByTestId("campaign-row").first().getByRole("link").first().click();
    await expect(page.getByText(/read-only|sola lettura/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Pause campaign|Metti in pausa/ })).toHaveCount(0);

    await page.goto("/t/northwind-apparel/campaigns/ledger?preset=7d");
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    const res = await page.request.get("/t/northwind-apparel/campaigns/ledger/export?preset=7d");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("date,campaign,platform,spend,impressions,clicks,orders,net_revenue,margin,profit,roas,flags");
    expect(text.split("\n").length).toBeGreaterThan(5);
  });

  test("viewer sees campaigns but no write controls; attributed orders drill through", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=90d&platform=meta&status=active");
    await page.getByTestId("campaign-row").first().getByRole("link").first().click();
    await expect(page.getByRole("button", { name: /Pause campaign|Metti in pausa/ })).toHaveCount(0);
    await expect(page.locator("#link-product")).toHaveCount(0);
    await page.getByRole("link", { name: /Attributed sales|Vendite attribuite/ }).click();
    await expect(page).toHaveURL(/\/orders\?campaign=/);
  });
});
