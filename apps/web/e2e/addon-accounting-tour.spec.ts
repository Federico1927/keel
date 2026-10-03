import { devices, expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tour of addon.accounting (#85, v1 in development) on the demo, in mock mode: every screen and
 * action, on a desktop and on an iPhone 15 (light). Northwind pushes one journal per closed day to
 * the simulated accounting system: pushed, waiting (an order with a write still pending) and failed
 * (rate limited) days, a re-pushed day, and one pushed day the reconciliation shows no longer
 * matches the sales summary. docs/addons/accounting.md describes the same tour in words.
 */
const N = "/t/northwind-apparel/accounting";
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 15"];
const row = (page: Page, status: string) => page.locator(`[data-testid='accounting-row'][data-status='${status}']`);

test.describe.configure({ mode: "serial" });

test.describe("accounting tour · desktop", () => {
  test("push log: counts, status filters, the waiting day's reason, a day's journal and its sales summary", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel");
    await page.getByRole("link", { name: "Accounting push" }).first().click();
    await page.waitForURL(/\/accounting$/);
    await expect(page.getByTestId("accounting-counts")).toContainText("Pushed");
    expect(await row(page, "pushed").count()).toBeGreaterThan(20);
    await expect(row(page, "waiting").first().getByTestId("accounting-detail")).toContainText(/#NW-\d+/);
    for (const status of ["waiting", "failed", "voided", "pushed"]) {
      await page.getByTestId("accounting-filters").getByRole("link", { name: { waiting: "Waiting", failed: "Failed", voided: "Voided", pushed: "Pushed" }[status]! }).click();
      await page.waitForURL(new RegExp(`status=${status}`));
      await expect(page.getByTestId("accounting-row").first()).toHaveAttribute("data-status", status);
    }
    await page.getByTestId("accounting-row").first().getByRole("link").first().click();
    await page.waitForURL(/\/accounting\/\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByTestId("journal-version").first()).toHaveAttribute("data-status", "pushed");
    await expect(page.getByTestId("journal-lines").first()).toContainText("1100");
    await page.getByRole("link", { name: "Daily sales of this day" }).click();
    await page.waitForURL(/\/analytics\/daily-sales\/\d{4}-\d{2}-\d{2}/);
    await expect(page.getByTestId("day-order").first()).toBeVisible();
  });

  test("reconciliation: a pushed day that no longer matches, its moved lines, re-pushed from the day page", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(N);
    const drift = page.getByTestId("drift-row").first();
    await expect(drift).toContainText("→");
    const day = (await drift.getAttribute("data-day"))!;
    await drift.getByRole("link").first().click();
    await page.waitForURL(new RegExp(`/accounting/${day}$`));
    await expect(page.getByTestId("journal-drift")).toContainText("Differs from what was pushed");
    await page.getByTestId("accounting-repush").click();
    await page.getByTestId("accounting-repush-confirm").click();
    await expect(page.getByTestId("journal-version").first()).toHaveAttribute("data-status", "pushed");
    await expect(page.locator("[data-testid=journal-version][data-status=voided]")).toHaveCount(1);
    await expect(page.getByTestId("journal-drift")).toHaveCount(0);
    await page.goto(N);
    await expect(page.locator(`[data-testid=drift-row][data-day='${day}']`)).toHaveCount(0);
  });

  test("a refusal and its retry: the simulated system refuses a re-push, the new version fails with the error, a retry pushes it", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    // the seeded failed push (rate limited): retry pushes it
    await page.goto(N);
    const seeded = row(page, "failed").first();
    if ((await seeded.count()) > 0) {
      const day = await seeded.getAttribute("data-day");
      await expect(seeded.getByTestId("accounting-detail")).toContainText(/rate_limited/);
      await seeded.getByTestId("accounting-retry").click();
      await expect(page.locator(`[data-testid=accounting-row][data-day='${day}'][data-status=pushed]`)).toHaveCount(1);
    }
    await page.goto("/t/northwind-apparel/integrations");
    const card = page.getByTestId("provider-accounting");
    await card.getByTestId("accounting-simulate-menu").click();
    await page.getByTestId("simulate-accounting-failure").click();
    await expect(page.getByTestId("msg-accounting")).toContainText("The next push will be refused");
    await page.goto(N);
    const pushed = row(page, "pushed").nth(1);
    const day = (await pushed.getAttribute("data-day"))!;
    const version = Number(await pushed.getAttribute("data-version"));
    await pushed.getByTestId("accounting-repush").click();
    await page.getByTestId("accounting-repush-confirm").click();
    const failed = page.locator(`[data-testid=accounting-row][data-day='${day}'][data-version='${version + 1}'][data-status=failed]`);
    await expect(failed).toHaveCount(1);
    await expect(failed.getByTestId("accounting-detail")).toContainText(/rate_limited/);
    await expect(failed.getByTestId("accounting-detail")).toContainText("Next attempt");
    await failed.getByTestId("accounting-retry").click();
    await expect(page.locator(`[data-testid=accounting-row][data-day='${day}'][data-version='${version + 1}'][data-status=pushed]`)).toHaveCount(1);
    // the waiting day still waits for its order's write: retry says why
    const waiting = row(page, "waiting").first();
    await waiting.getByTestId("accounting-retry").click();
    await expect(waiting.getByTestId("accounting-message")).toHaveText("The day still waits: see the reasons.");
    await page.getByTestId("accounting-run").click();
    await expect(page.getByTestId("accounting-run").locator("..").getByTestId("accounting-message")).toContainText(/Pushed \d+, waiting \d+, failed \d+\./);
  });

  test("settings: the chart of accounts, the mapping per line and tax rate, push rules; card test and resync; guide", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(N);
    await page.getByTestId("accounting-settings-link").click();
    await page.waitForURL(/\/accounting\/settings$/);
    await expect(page.getByTestId("accounting-chart")).toContainText("Payment processors clearing");
    await expect(page.getByTestId("map-sales")).toHaveValue("4000");
    await expect(page.getByTestId("rate-row").first()).toBeVisible();
    const status = page.locator("#acc-status");
    const next = (await status.inputValue()) === "draft" ? "posted" : "draft";
    await status.selectOption(next);
    await page.getByTestId("accounting-save").click();
    await expect(page.getByTestId("accounting-message")).toBeVisible();
    await page.reload();
    await expect(page.locator("#acc-status")).toHaveValue(next);
    const card = page.getByTestId("provider-accounting");
    await card.getByTestId("accounting-test").click();
    await expect(card.getByTestId("msg-accounting")).toContainText("Connection OK");
    await card.getByTestId("accounting-manage").click();
    await page.getByTestId("integration-sheet").getByTestId("accounting-resync").click();
    await expect(page.getByTestId("msg-accounting")).toContainText("12 accounts read");
    await page.keyboard.press("Escape");
    await page.goto("/t/northwind-apparel/integrations/guide/accounting");
    await expect(page.getByTestId("guide-step").first()).toBeVisible();
    await expect(page.getByText(/Xero/).first()).toBeVisible();
  });

  test("the console shows the add-on active on Northwind with its version in development", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: "Northwind Apparel" }).first().click();
    await expect(page.getByTestId("addon-version-addon.accounting-1")).toContainText("in development");
    await expect(page.getByTestId("addon-addon.accounting")).toBeChecked();
  });
});

test.describe("accounting tour · mobile-iphone15-light", () => {
  test.use({ ...iphone, viewport: { width: 393, height: 852 }, colorScheme: "light" });

  test("push log, reconciliation, a day's journal and the settings fit the phone; retry works from the card layout", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(N);
    await expect(page.getByTestId("accounting-reconciliation")).toBeVisible();
    await expect(page.getByTestId("accounting-log").locator("thead")).toBeHidden();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    const waiting = row(page, "waiting").first();
    await waiting.getByTestId("accounting-retry").click();
    await expect(waiting.getByTestId("accounting-message")).toBeVisible();
    const day = await row(page, "pushed").first().getAttribute("data-day");
    await page.goto(`${N}/${day}`);
    await expect(page.getByTestId("journal-lines").first()).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.goto(`${N}/settings`);
    await expect(page.getByTestId("accounting-mapping")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.goto("/t/northwind-apparel/integrations/guide/accounting");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});
