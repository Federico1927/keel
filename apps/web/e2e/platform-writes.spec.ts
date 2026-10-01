import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("platform writes, stock sync and reconcile runs", () => {
  test("a price edit goes through the outbox and is listed as synced on the integrations page", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/products");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByText(/Variants and stock|Varianti e giacenze/)).toBeVisible();
    await page.waitForLoadState("networkidle");
    const price = page.getByRole("spinbutton", { name: /^Price$|^Prezzo$/ }).first();
    const current = Number(await price.inputValue());
    await price.fill((current + 1).toFixed(2));
    const form = page.locator("form", { has: price });
    await form.getByRole("button", { name: /^Save$|^Salva$/ }).click();
    await expect(form.getByRole("button", { name: /^Save$|^Salva$/ })).toHaveCount(0);
    // synced: no pending or failed badge on the edited variant
    const row = page.locator("tr", { has: price });
    await expect(row.getByTestId("platform-write-status").filter({ hasText: /./ }).and(page.locator('[data-status="failed"], [data-status="pending"]'))).toHaveCount(0);
    await page.goto("/t/northwind-apparel/integrations");
    const latest = page.getByTestId("platform-write-row").first();
    await expect(latest).toHaveAttribute("data-kind", "variant.update");
    await expect(latest).toHaveAttribute("data-status", "succeeded");
  });

  test("the integrations page shows the nightly reconcile summary and a failed write can be retried", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    await expect(page.locator('[data-testid="sync-run-row"][data-kind="reconcile"][data-object="catalog"]').first()).toBeVisible();
    const writes = page.getByTestId("platform-writes");
    await expect(writes).toBeVisible();
    const failed = writes.locator('[data-testid="platform-write-row"][data-status="failed"]').first();
    if ((await failed.count()) > 0) {
      await expect(failed).toContainText(/write_products/);
      const kind = await failed.getAttribute("data-kind");
      await failed.getByRole("button", { name: /^Retry$|^Riprova$/ }).click();
      await expect(writes.locator(`[data-testid="platform-write-row"][data-kind="${kind}"][data-status="failed"]`)).toHaveCount(0);
    }
  });

  test("Sync now on the inventory page reads stock and the drift log is visible", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/inventory");
    await expect(page.getByTestId("inventory-drift")).toBeVisible();
    await page.getByTestId("inventory-sync-now").click();
    await expect(page.getByTestId("inventory-sync-result")).toHaveText(/Stock read|Stock letto|paused|sospesa/, { timeout: 60_000 });
    await expect(page.getByTestId("drift-row").first()).toBeVisible();
  });
});
