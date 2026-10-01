import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("dashboard and analytics", () => {
  test("dashboard shows running KPIs, work queue and a chart", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Dashboard/);
    await expect(page.getByText(/Needs attention|Da gestire/)).toBeVisible();
    await expect(page.locator(".recharts-responsive-container").first()).toBeVisible();
    await page.getByRole("link", { name: /Pending review|Da verificare/ }).first().click();
    await expect(page).toHaveURL(/orders\?status=pending_review/);
  });

  test("analytics tabs render and numbers drill through to orders", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/analytics?preset=90d");
    await expect(page.getByText(/Net revenue|Ricavo netto/).first()).toBeVisible();
    await page.getByRole("link", { name: /^P\/L$/ }).click();
    await expect(page.getByText(/Operating profit|Risultato operativo/).first()).toBeVisible();
    await expect(page.getByText(/By month|Per mese/)).toBeVisible();
    await page.getByRole("link", { name: /Products|Prodotti/ }).first().click();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    await page.getByRole("link", { name: /Cohorts|Coorti/ }).click();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/analytics?preset=30d&tab=overview");
    await page.getByRole("link", { name: /Sale orders|Ordini di vendita/ }).first().click();
    await expect(page).toHaveURL(/\/orders\?from=.*status=confirmed/);
  });
});
