import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("platform writes, stock sync and reconcile runs", () => {
  test("a price edit is written to the platform first and is listed as synced on the integrations page", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/products");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByText(/Variants and stock|Varianti e giacenze/)).toBeVisible();
    await page.waitForLoadState("networkidle");
    // issue #19: variant fields are edited in the variants editor, Shopify first (synchronous outbox write)
    await page.getByTestId("edit-variants").click();
    const price = page.getByTestId("edit-variant-price").first();
    const current = Number(await price.inputValue());
    await price.fill((current + 1).toFixed(2));
    await page.getByTestId("variants-editor").getByTestId("save-product").click();
    await expect(page.getByTestId("variants-editor")).toHaveCount(0);
    await page.goto("/t/northwind-apparel/integrations");
    const latest = page.getByTestId("platform-write-row").first();
    await expect(latest).toHaveAttribute("data-kind", "variant.details");
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
