import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Several Meta ad accounts and conversion retractions (#82). */
test.describe("Meta ad accounts", () => {
  test("the campaigns list names each campaign's account and filters by it, on desktop and phone", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=90d");
    await expect(page.getByTestId("campaign-account").first()).toBeVisible();
    await page.getByTestId("campaign-account-filter").selectOption("act_demo_outlet");
    await expect(page).toHaveURL(/account=act_demo_outlet/);
    const rows = page.getByTestId("campaign-row");
    await expect(rows).toHaveCount(4);
    for (const text of await page.getByTestId("campaign-account").allTextContents()) expect(text).toContain("Northwind Outlet");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("campaign-account-filter")).toBeVisible();
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toBeVisible();
    await page.getByTestId("campaign-account-filter").selectOption("");
    await expect(page).not.toHaveURL(/account=/);
    expect(await rows.count()).toBeGreaterThan(4);
  });

  // adding and removing accounts is covered by the service tests: a simulated account's campaigns stay after removal and would change other specs' demo data
  test("the integrations page lists both Meta accounts, each with its own status and actions", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    const card = page.getByTestId("meta-ad-accounts");
    const primary = card.locator('[data-testid="ad-account-row"][data-account="act_demo"]');
    const outlet = card.locator('[data-testid="ad-account-row"][data-account="act_demo_outlet"]');
    await expect(primary).toBeVisible();
    await expect(outlet).toContainText("Northwind Outlet");
    await expect(outlet).toHaveAttribute("data-status", "connected");
    await expect(primary.getByTestId("ad-account-remove")).toHaveCount(0);
    await expect(outlet.getByTestId("ad-account-remove")).toBeVisible();
    await expect(card.getByTestId("ad-account-add-mock")).toBeVisible();
    await outlet.getByRole("button", { name: /test connection|testa connessione/i }).click();
    await expect(card.getByTestId("ad-accounts-msg")).toContainText("Northwind Outlet");
  });

  test("cancelling an order in the app shows its retraction in the conversions log", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations/tracking");
    const sent = page.locator('[data-testid="conversion-row"][data-kind="purchase"][data-status="sent"][data-provider="google"]').first();
    await expect(sent).toBeVisible();
    const link = sent.getByRole("link");
    const orderName = (await link.textContent())!.trim();
    await link.click();
    await page.getByRole("button", { name: /cancel order|annulla ordine/i }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: /cancel order|annulla ordine/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/t/northwind-apparel/integrations/tracking?log=adjustments");
    const google = page.locator('[data-testid="conversion-row"][data-kind="retraction"][data-provider="google"]').filter({ hasText: orderName });
    await expect(google).toHaveAttribute("data-status", "pending");
    await expect(page.locator('[data-testid="conversion-row"][data-kind="retraction"][data-provider="meta"]').filter({ hasText: orderName })).toHaveAttribute("data-status", "skipped");
    await page.getByTestId("conversions-run").click();
    await expect(google).toHaveAttribute("data-status", "sent");
  });
});
