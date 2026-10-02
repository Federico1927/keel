import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Daily sales summary (core, every tenant) and the accounting push add-on (#85): on for Northwind, off for Harbor Home. */
test.describe("daily sales summary and addon.accounting", () => {
  test("Harbor Home: the summary page from Analytics, a day's orders behind its numbers, and the CSV", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/analytics");
    await page.getByTestId("daily-sales-link").click();
    await page.waitForURL(/\/analytics\/daily-sales/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Daily sales summary");
    await expect(page.getByTestId("summary-totals")).toBeVisible();
    await expect(page.getByTestId("summary-scope")).toContainText("America/New_York");
    const days = page.getByTestId("summary-day");
    expect(await days.count()).toBeGreaterThan(5);
    // the wide grid by tax rate is a marked region that scrolls by itself
    await expect(page.getByRole("region", { name: /tax rate/ })).toBeVisible();
    // a day's total opens the orders behind it
    const day = await days.first().getAttribute("data-day");
    await days.first().getByRole("link").first().click();
    await page.waitForURL(new RegExp(`/analytics/daily-sales/${day}`));
    await expect(page.getByTestId("day-order").first()).toBeVisible();
    await expect(page.getByTestId("day-net")).toBeVisible();
    await page.getByTestId("day-order").first().getByRole("link").first().click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}/);
    // CSV of the same period: a row per day and rate, fees per method, day and period totals
    const res = await page.request.get("/t/harbor-home/analytics/export/daily_sales?preset=30d");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const csv = await res.text();
    expect(csv.split("\n")[0]).toBe("day,line,country,rate_percent,method,orders,refund_orders,gross_sales,discounts,refunds,net_sales,shipping,tax,total,fees,net");
    expect(csv).toContain(",rate,US,");
    expect(csv).toContain(",day_total,");
    expect(csv.trim().split("\n").pop()).toMatch(/^TOTAL,period_total,/);
  });

  test("Harbor Home (add-on off): push log, settings, journal pages, guide, card and nav entries are unreachable", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    for (const path of ["/accounting", "/accounting/settings", "/accounting/2026-09-01", "/integrations/guide/accounting"]) {
      const res = await page.goto(`/t/harbor-home${path}`);
      expect(res?.status(), path).toBe(404);
    }
    await page.goto("/t/harbor-home/integrations");
    await expect(page.getByTestId("provider-shopify")).toBeVisible();
    await expect(page.getByTestId("provider-accounting")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Accounting push|Accounting settings/ })).toHaveCount(0);
  });

  test("Northwind: the push log shows pushed, waiting and failed days; retry and re-push", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel");
    await page.getByRole("link", { name: /^(Accounting push|Invio in contabilità|Envío a contabilidad)$/ }).first().click();
    await page.waitForURL(/\/accounting$/);
    const rows = page.getByTestId("accounting-row");
    expect(await rows.count()).toBeGreaterThan(20);
    expect(await page.locator("[data-testid='accounting-row'][data-status='pushed']").count()).toBeGreaterThan(20);
    // the seeded waiting day names its order and why it waits
    const waiting = page.locator("[data-testid='accounting-row'][data-status='waiting']").first();
    await expect(waiting.getByTestId("accounting-detail")).toContainText(/#NW-\d+/);
    // a failed push shows its error; "Retry now" pushes it (the simulated system accepts)
    const failed = page.locator("[data-testid='accounting-row'][data-status='failed']").first();
    if ((await failed.count()) > 0) {
      const day = await failed.getAttribute("data-day");
      await expect(failed.getByTestId("accounting-detail")).toContainText(/rate_limited/);
      await failed.getByTestId("accounting-retry").click();
      await expect(page.locator(`[data-testid='accounting-row'][data-day='${day}'][data-status='pushed']`)).toHaveCount(1);
    }
    // re-push the latest pushed day: confirmed, the old version voided, the new one pushed
    const pushed = page.locator("[data-testid='accounting-row'][data-status='pushed']").first();
    const day = await pushed.getAttribute("data-day");
    const version = Number(await pushed.getAttribute("data-version"));
    await pushed.getByTestId("accounting-repush").click();
    await page.getByTestId("accounting-repush-confirm").click();
    await expect(page.locator(`[data-testid='accounting-row'][data-day='${day}'][data-version='${version + 1}'][data-status='pushed']`)).toHaveCount(1);
    await expect(page.locator(`[data-testid='accounting-row'][data-day='${day}'][data-version='${version}'][data-status='voided']`)).toHaveCount(1);
    // the day's journal: every version with its balanced lines
    await page.locator(`[data-testid='accounting-row'][data-day='${day}']`).first().getByRole("link").first().click();
    await page.waitForURL(new RegExp(`/accounting/${day}$`));
    await expect(page.getByTestId("journal-version")).toHaveCount(version + 1);
    await expect(page.getByTestId("journal-lines").first()).toBeVisible();
  });

  test("Northwind: settings map the accounts, the card tests and resyncs, the guide lists the candidate systems", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/accounting/settings");
    const card = page.getByTestId("provider-accounting");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("accounting-chart")).toBeVisible();
    await expect(page.getByTestId("map-shipping")).toHaveValue("4090");
    await expect(page.getByTestId("rate-row").first()).toBeVisible();
    const lookback = page.locator("#acc-lookback");
    const next = (await lookback.inputValue()) === "30" ? "35" : "30";
    await lookback.fill(next);
    await page.getByTestId("accounting-save").click();
    await expect(page.getByTestId("accounting-message")).toBeVisible();
    await page.reload();
    await expect(page.locator("#acc-lookback")).toHaveValue(next);
    await card.getByTestId("accounting-test").click();
    await expect(card.getByTestId("accounting-message")).toBeVisible();
    await card.getByTestId("accounting-resync").click();
    await expect(card.getByTestId("accounting-message")).toContainText(/12/);
    await page.goto("/t/northwind-apparel/integrations");
    await expect(page.getByTestId("provider-accounting")).toBeVisible();
    await page.goto("/t/northwind-apparel/integrations/guide/accounting");
    await expect(page.getByTestId("guide-step").first()).toBeVisible();
    await expect(page.getByText(/Xero/).first()).toBeVisible();
    await expect(page.getByText(/Fatture in Cloud/).first()).toBeVisible();
    expect(await page.getByText(/^(To verify|Da verificare|Por verificar)$/).count()).toBeGreaterThan(0);
  });

  test("phone width: the summary and a day never scroll sideways; the rate grid scrolls inside its frame", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/analytics/daily-sales");
    await expect(page.getByTestId("summary-days")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    const scroll = page.getByTestId("rates-scroll");
    expect(await scroll.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    const day = await page.getByTestId("summary-day").first().getAttribute("data-day");
    await page.goto(`/t/harbor-home/analytics/daily-sales/${day}`);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test("phone width: the push log and the accounting settings never scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "owner@northwind.demo");
    for (const path of ["/accounting", "/accounting/settings"]) {
      await page.goto(`/t/northwind-apparel${path}`);
      await expect(page.locator("main")).toBeVisible();
      expect(await overflow(page), path).toBeLessThanOrEqual(1);
    }
  });
});
