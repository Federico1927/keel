import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Data completeness widget (issue #99) on the tenant home: the gaps of the demo, each row linking to the
 * page or filter where it gets fixed, the full list behind "See all", and per-role rows.
 */
const NW = "/t/northwind-apparel";

async function widget(page: Page) {
  await page.goto(NW);
  const w = page.getByTestId("widget-setup-health");
  await w.scrollIntoViewIfNeeded();
  await expect(w).toBeVisible();
  return w;
}

test.describe("data completeness widget (issue #99)", () => {
  test("the owner sees the gaps with a score; each row opens the filtered page that fixes it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "owner@northwind.demo");
    const w = await widget(page);
    await expect(w.getByTestId("setup-health-score")).toBeVisible();
    // the demo's realistic mix: costs missing on sold variants, campaigns without products, last month's invoice not in yet
    for (const id of ["product_costs", "campaign_links", "cost_actuals"]) await expect(w.locator(`[data-check="${id}"]`)).toBeVisible();
    // the widget's cell reserves the card's height: nothing below it moves while it streams
    const box = await w.boundingBox();
    expect(Math.round(box!.height)).toBe(416);

    await w.locator('[data-check="product_costs"]').click();
    await expect(page).toHaveURL(/\/products\/quality\?issue=missing_cost$/);

    const w2 = await widget(page);
    await w2.locator('[data-check="campaign_links"]').click();
    await expect(page).toHaveURL(/\/campaigns\?links=none&preset=30d$/);
    await expect(page.getByTestId("campaigns-unlinked-filter")).toBeVisible();
    const rows = page.getByTestId("campaign-row");
    expect(await rows.count()).toBeGreaterThan(0);
    // every listed campaign has no linked product
    for (const text of await rows.allTextContents()) expect(text).toMatch(/0 linked|0 collegat|0 vinculad/i);

    const w3 = await widget(page);
    await w3.locator('[data-check="payment_fees"]').click();
    await expect(page).toHaveURL(/\/settings\?tab=operational$/);
    await expect(page.locator('[role="tab"][data-state="active"]')).toHaveAttribute("id", /-trigger-operational$/);
  });

  test("on a phone (393px) the widget fits the screen and See all lists every check", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await login(page, "owner@northwind.demo");
    const w = await widget(page);
    const box = await w.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(393);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
    await expect(w.getByTestId("setup-health-row").first()).toBeVisible();
    await w.getByTestId("setup-health-all").click();
    await expect(page).toHaveURL(/\/data-health$/);
    await expect(page.getByTestId("data-health-item").first()).toBeVisible();
    await expect(page.getByTestId("data-health-passed")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  });

  test("operations only sees rows it can act on; a viewer sees neither the widget nor the page", async ({ page, browser }) => {
    await login(page, "ops@northwind.demo");
    const w = await widget(page);
    const checks = await w.getByTestId("setup-health-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-check")));
    expect(checks.length).toBeGreaterThan(0);
    // products and purchasing are the pages operations writes; settings, campaigns and integrations rows stay hidden
    expect(checks.every((c) => c === "product_costs" || c === "suppliers")).toBe(true);
    await expect(w.locator('[data-check="campaign_links"]')).toHaveCount(0);

    const viewer = await (await browser.newContext()).newPage();
    await login(viewer, "viewer@northwind.demo");
    await viewer.goto(NW);
    await expect(viewer.getByTestId("dashboard-grid")).toBeVisible();
    await expect(viewer.getByTestId("widget-loading")).toHaveCount(0, { timeout: 30_000 });
    await expect(viewer.locator('[data-widget="setup_health"]')).toHaveCount(0);
    const res = await viewer.goto(`${NW}/data-health`);
    expect(res?.status()).toBe(404);
  });
});
