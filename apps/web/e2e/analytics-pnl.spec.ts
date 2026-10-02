import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

test.describe("analytics depth: P/L per order, periods, products with ads, UTM", () => {
  test("per-order P/L reconciles to the period and matches the order's economics card", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/analytics?preset=30d&tab=orders_pnl`);
    await expect(page.getByTestId("order-pnl-row").first()).toBeVisible();
    await expect(page.getByTestId("orders-pnl-reconciliation")).toContainText(/Matches the period P\/L to the cent|Coincide al centesimo/);
    // CSV export of every row
    const csv = await page.request.get(`${T}/analytics/export/orders?preset=30d`);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect((await csv.text()).split("\n")[0]).toContain("contribution");
    // loss-making filter keeps the URL state
    const filters = page.getByTestId("orders-pnl-filters");
    await filters.getByLabel(/Loss-making|In perdita/).check();
    await filters.getByRole("button", { name: /^Apply$|^Applica$/ }).click();
    await expect(page).toHaveURL(/loss=1/);
    // the row's contribution equals the card on the order page
    await page.goto(`${T}/analytics?preset=30d&tab=orders_pnl`);
    const row = page.getByTestId("order-pnl-row").first();
    const contribution = (await row.locator("td").last().innerText()).trim();
    await row.getByRole("link").first().click();
    await expect(page.getByTestId("order-economics")).toBeVisible();
    await expect(page.getByTestId("economics-contribution")).toContainText(contribution);
    // the fee is the payout's actual one when imported, the estimate otherwise (issue #27)
    await expect(page.getByTestId("economics-fee")).toContainText(/estimated|stima|actual|effettiva/);
  });

  test("P/L by period with granularity, partial periods and a chart", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/analytics?preset=90d&tab=pnl`);
    await expect(page.getByTestId("pnl-chart")).toBeVisible();
    await page.getByTestId("gran-month").click();
    await expect(page).toHaveURL(/gran=month/);
    await expect(page.getByTestId("pnl-bucket").first()).toBeVisible();
    await expect(page.getByTestId("pnl-bucket").filter({ hasText: /partial|parziale/ }).first()).toBeVisible();
    await expect(page.getByTestId("pnl-bucket-total")).toBeVisible();
    // a bucket opens the per-order table for its dates
    await page.getByTestId("pnl-bucket").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/tab=orders_pnl&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });

  test("product table with ad spend, unattributed row, stock action and drill-down to orders", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto(`${T}/analytics?preset=90d&tab=products`);
    await expect(page.getByTestId("product-profit-row").first()).toBeVisible();
    await expect(page.getByTestId("unattributed-row")).toBeVisible();
    await expect(page.getByTestId("product-ad-spend-total")).not.toBeEmpty();
    const filters = page.getByTestId("products-filters");
    await filters.getByLabel(/^Sort$|^Ordina$/).selectOption("ad_spend_desc");
    await filters.getByRole("button", { name: /^Apply$|^Applica$/ }).click();
    await expect(page).toHaveURL(/sort=ad_spend_desc/);
    const csv = await page.request.get(`${T}/analytics/export/products?preset=90d`);
    expect(await csv.text()).toContain("UNATTRIBUTED AD SPEND");
    await page.getByTestId("product-profit-row").first().locator("td").nth(1).getByRole("link").click();
    await expect(page).toHaveURL(/\/orders\?.*product=/);
    await expect(page.getByTestId("filter-product")).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("UTM drill-down narrows level by level and links to the orders behind each number", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto(`${T}/analytics?preset=90d&tab=utm`);
    await expect(page.getByTestId("utm-row").first()).toBeVisible();
    await expect(page.getByTestId("channel-trend")).toBeVisible();
    await page.getByTestId("utm-row").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/dim=medium/);
    await expect(page.getByTestId("utm-crumbs")).toBeVisible();
    await page.getByTestId("utm-row").first().locator("td").nth(1).getByRole("link").click();
    await expect(page).toHaveURL(/\/orders\?.*utmSource=.*utmMedium=/);
    await expect(page.getByTestId("filter-utmSource")).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("overview data-quality widget links to the missing-cost orders; customer care sees no economics", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/analytics?preset=ytd`);
    await expect(page.getByTestId("data-quality")).toBeVisible();
    await page.getByTestId("quality-incomplete-orders").click();
    await expect(page).toHaveURL(/\/orders\?.*missingCost=1/);
    await expect(page.getByTestId("filter-missing-cost")).toBeVisible();
    const orderHref = await page.locator("table tbody tr").first().getByRole("link").first().getAttribute("href");
    // late prefetch responses can set the session cookie again after it is cleared
    await page.waitForLoadState("networkidle");
    await page.context().clearCookies();
    await login(page, "care@northwind.demo");
    await page.goto(orderHref!);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("order-economics")).toHaveCount(0);
  });
});
