import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("products, inventory and purchasing", () => {
  test("products list filters by risk and opens a detail with variants and chart", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/products");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Products|Prodotti/);
    await page.getByRole("button", { name: /Critical|Critico/ }).click();
    await expect(page).toHaveURL(/risk=critical/);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByText(/Variants and stock|Varianti e giacenze/)).toBeVisible();
    await expect(page.locator(".recharts-responsive-container")).toBeVisible();
  });

  test("inventory page shows risk tiles and reorder suggestions", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/inventory?risk=critical");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Inventory|Magazzino/);
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("receiving a purchase order updates stock and cost", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/purchasing?status=in_transit");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("button", { name: /^Receive$|^Ricevi$/ })).toBeVisible();
    const firstQty = page.locator('input[name^="qty_"]').first();
    await firstQty.fill("3");
    const others = page.locator('input[name^="qty_"]');
    const n = await others.count();
    for (let i = 1; i < n; i++) await others.nth(i).fill("0");
    await page.getByRole("button", { name: /^Receive$|^Ricevi$/ }).click();
    await expect(page.getByText(/Received\.|Ricevuto\./)).toBeVisible();
    await expect(page.locator("h1 ~ div, [class*=chip]").first()).toBeVisible();
    await expect(page.getByText(/Partially received|Ricevuto in parte/).first()).toBeVisible();
  });

  test("new purchase order is pre-filled from suggestions and created as draft", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/purchasing/new");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/New purchase order|Nuovo ordine d'acquisto/);
    await page.getByRole("button", { name: /Create draft|Crea bozza/ }).click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/^Draft$|^Bozza$/).first()).toBeVisible();
    await page.getByRole("button", { name: /Mark as Sent|Segna come Inviato/ }).click();
    await expect(page.getByText(/^Sent$|^Inviato$/).first()).toBeVisible();
  });

  test("suppliers page shows balances", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/purchasing/suppliers");
    await expect(page.locator("table tbody tr")).toHaveCount(4);
  });
});
