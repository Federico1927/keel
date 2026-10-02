import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Stripe billing (#53) in mock mode (no key): the console starts a subscription, the mock plays
 * Stripe's webhooks through the same processing, the owner sees the billing page, the portal
 * (mock) and the past-due banner; other roles see neither. Safe to re-run on the same database.
 */
async function openTenant(page: Page, q: string, name: string) {
  await page.goto(`/admin/tenants?q=${q}`);
  await page.getByTestId("tenant-row").filter({ hasText: name }).getByRole("link", { name }).click();
  await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("subscription-card")).toBeVisible();
}

async function startAndComplete(page: Page, email: string) {
  const start = page.getByTestId("start-subscription");
  if (await start.isVisible()) {
    await start.click();
    await page.getByTestId("ss-email").fill(email);
    await page.getByTestId("confirm-start-subscription").click();
    await expect(page.getByTestId("checkout-url")).toContainText("mock_checkout=");
    await expect(page.getByTestId("checkout-email")).toContainText(email);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("checkout-pending")).toBeVisible();
    await page.getByTestId("simulate-checkout").click();
  }
  await expect(page.getByTestId("external-status")).toBeVisible();
}

test.describe("Stripe billing (mock)", () => {
  test("console: catalog, start subscription with the emailed link, simulated checkout, subscriptions page", async ({ page }) => {
    await login(page, "superadmin@keel.demo");
    await page.goto("/admin/billing/subscriptions");
    await expect(page.getByTestId("billing-mode")).toHaveAttribute("data-mode", "mock");
    await expect(page.getByTestId("stripe-not-configured")).toBeVisible();
    await page.getByTestId("sync-catalog").click();
    await expect(page.getByTestId("catalog-sync-result")).toBeVisible();
    await expect(page.getByTestId("catalog-row")).toHaveCount(8);

    await openTenant(page, "alpine", "Alpine Outdoor");
    await startAndComplete(page, "billing@alpine-outdoor.demo");
    await expect(page.getByTestId("external-status")).toHaveText(/Active|Trial/);
    await expect(page.getByTestId("start-subscription")).toHaveCount(0);

    await page.goto("/admin/billing/subscriptions");
    await expect(page.getByTestId("subscription-row").filter({ hasText: "Alpine Outdoor" })).toBeVisible();
    await expect(page.getByTestId("last-webhook")).not.toHaveText(/None received/);
  });

  test("owner: billing page, mock portal, invoice download and the past-due banner; other roles see neither", async ({ page, browser }) => {
    await login(page, "superadmin@keel.demo");
    await openTenant(page, "harbor", "Harbor Home");
    await startAndComplete(page, "billing@harborhome.demo");
    // a declined renewal: past due at once
    await page.getByTestId("simulate-failed").click();
    await expect(page.getByRole("status").filter({ hasText: /events processed/ })).toBeVisible();

    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await login(owner, "owner@harborhome.demo");
    await owner.goto("/t/harbor-home");
    await expect(owner.getByTestId("billing-banner")).toHaveAttribute("data-kind", "past_due");
    await owner.goto("/t/harbor-home/settings");
    await owner.getByTestId("billing-settings-link").click();
    await expect(owner).toHaveURL(/\/t\/harbor-home\/settings\/billing$/);
    await expect(owner.getByTestId("billing-plan")).toBeVisible();
    await expect(owner.getByTestId("payment-status")).toHaveText(/overdue|Suspended/i);
    expect(await owner.getByTestId("billing-invoice-row").count()).toBeGreaterThan(0);
    const href = await owner.getByTestId("invoice-download").first().getAttribute("href");
    const pdf = await owner.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    await owner.getByTestId("manage-payment").click();
    await expect(owner).toHaveURL(/mock_portal=1/);
    await expect(owner.getByTestId("billing-notice")).toBeVisible();
    // mobile width: the page stays usable
    await owner.setViewportSize({ width: 390, height: 844 });
    await expect(owner.getByTestId("manage-payment")).toBeVisible();
    await ownerCtx.close();

    const opsCtx = await browser.newContext();
    const ops = await opsCtx.newPage();
    await login(ops, "ops@harborhome.demo");
    await ops.goto("/t/harbor-home");
    await expect(ops.getByTestId("billing-banner")).toHaveCount(0);
    expect((await ops.goto("/t/harbor-home/settings/billing"))?.status()).toBe(404);
    await opsCtx.close();
  });
});
