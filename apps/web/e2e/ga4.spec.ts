import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Issue #86: GA4 traffic. Northwind has its property connected to the simulator; Harbor Home is not
 * connected (the empty state and the self-setup checklist). Nothing here changes demo data: the wrong
 * property id is refused before anything is saved.
 */
test.describe("GA4", () => {
  test("Northwind: the integration card is connected and answers the connection test", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    const card = page.getByTestId("provider-ga4");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("ga4-status")).toHaveText(/^Connected$|^Collegata$|^Collegato$/);
    await expect(card).toContainText("312456789");
    await expect(card.getByTestId("ga4-last-day")).not.toHaveText("—");
    await card.getByTestId("ga4-test").click();
    await expect(card.getByTestId("ga4-msg")).toContainText(/Connection OK|Connessione OK/);
    await card.getByTestId("ga4-properties").click();
    await expect(card.getByTestId("ga4-property-picker").locator("option")).toHaveCount(2);
    await expect(card.locator('a[href$="/integrations/guide/ga4"]')).toBeVisible();
  });

  test("Northwind: conversion rate by channel links to the orders and to the GA4 rows", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/analytics?tab=traffic&preset=30d");
    const rows = page.getByTestId("traffic-channel-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    const paid = rows.filter({ has: page.locator('[data-key="paid_social"]') }).first();
    const row = (await paid.count()) ? paid : rows.first();
    await expect(row.getByTestId("ga4-cr-channel")).toHaveText(/\d.*%/);
    await expect(page.getByTestId("traffic-why")).toBeVisible();
    await expect(page.getByTestId("traffic-landing-row").first()).toBeVisible();
    // sessions → the GA4 rows behind them
    const sessions = row.getByTestId("sessions-link-channel");
    await expect(sessions).toHaveAttribute("href", /\/analytics\/traffic\?.*channel=/);
    await sessions.click();
    await expect(page).toHaveURL(/\/analytics\/traffic\?/);
    await expect(page.getByTestId("traffic-row").first()).toBeVisible();
    await expect(page.getByTestId("traffic-filters")).toBeVisible();
    // orders → the orders list with the same channel
    await page.goBack();
    const orders = page.getByTestId("traffic-channel-row").first().getByTestId("orders-link-channel");
    await expect(orders).toHaveAttribute("href", /\/orders\?.*channel=web.*attrChannel=/);
    await orders.click();
    await expect(page).toHaveURL(/\/orders\?.*attrChannel=/);
    await expect(page.getByRole("link", { name: /^#NW-\d+$/ }).first()).toBeVisible();
  });

  test("Northwind: campaign rows show GA4 sessions next to spend and orders", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=90d&platform=meta");
    const link = page.getByTestId("campaign-ga4-sessions").first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /\/analytics\/traffic\?.*campaignId=/);
    await link.click();
    await expect(page.getByTestId("traffic-row").first()).toBeVisible();
  });

  test("Harbor: not connected, empty state, self-setup checklist explains a wrong property", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/analytics?tab=traffic");
    await expect(page.getByTestId("ga4-empty-cta")).toBeVisible();
    await expect(page.getByTestId("traffic-channel-row")).toHaveCount(0);
    await page.getByTestId("ga4-empty-cta").click();
    const card = page.getByTestId("provider-ga4");
    await expect(card.getByTestId("ga4-status")).toHaveText(/^Not connected$/);
    await expect(card.getByTestId("setup-step")).toHaveCount(6);
    await expect(card.getByTestId("setup-copy-serviceAccountEmail")).toHaveText(/@.+\.iam\.gserviceaccount\.com$/);
    await card.getByTestId("ga4-setup-property").fill("111111111");
    await card.getByTestId("ga4-setup-connect").click();
    await expect(card.getByTestId("setup-error")).toHaveAttribute("data-code", "no_access");
    await expect(card.getByTestId("setup-error")).toContainText(/No access to this property/);
    await expect(card.getByTestId("ga4-status")).toHaveText(/^Not connected$/);
    await page.goto("/t/harbor-home/integrations/guide/ga4");
    await expect(page.getByTestId("guide-step")).toHaveCount(9);
    await expect(page.getByTestId("ga4-apis")).toContainText("analytics.readonly");
  });

  test("phone width: the Traffic tab fits the screen, wide tables scroll in their own container", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "owner@northwind.demo");
    for (const path of ["/t/northwind-apparel/analytics?tab=traffic", "/t/northwind-apparel/analytics/traffic", "/t/northwind-apparel/integrations"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(m.scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(m.client);
    }
    await page.goto("/t/northwind-apparel/analytics?tab=traffic");
    const region = page.locator('[data-scroll="x"]').first();
    await expect(region).toBeVisible();
    expect(await region.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    await expect(page.getByTestId("traffic-channel-row").first()).toBeVisible();
  });
});
