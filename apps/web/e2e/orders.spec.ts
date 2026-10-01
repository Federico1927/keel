import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("orders and shipments", () => {
  test("orders list searches, filters by status and opens a detail with timeline", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/orders");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Orders|Ordini/);
    await expect(page.locator("table tbody tr")).toHaveCount(50);
    await page.getByRole("button", { name: /Delivered|Consegnato/ }).first().click();
    await expect(page).toHaveURL(/status=delivered/);
    await expect(page.locator("table tbody tr").first()).toContainText(/Delivered|Consegnato/);
    const firstOrder = page.locator("table tbody tr").first().getByRole("link").first();
    const name = (await firstOrder.textContent())?.trim() ?? "";
    await firstOrder.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.getByText(/Timeline|Cronología/)).toBeVisible();
    await expect(page.getByText(/Customer history|Storico cliente/)).toBeVisible();
    // search by number goes straight to it
    const number = name.replace(/^#NW-/, "");
    await page.goto(`/t/northwind-apparel/orders?q=${number}`);
    await expect(page.locator("table tbody tr")).toHaveCount(1);
  });

  test("operator changes status with a note and adds an internal note with a mention", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/orders?status=confirmed");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await page.getByRole("button", { name: /Change status|Cambia stato/ }).click();
    await page.getByRole("menuitem", { name: /^On hold$|^In attesa$/ }).click();
    await page.getByLabel(/Note \(optional\)|Nota \(facoltativa\)/).fill("waiting for customer");
    await page.getByRole("button", { name: /^Confirm$|^Conferma$/ }).click();
    await expect(page.getByText(/manual|manuale/).first()).toBeVisible();
    await expect(page.getByText("Status changed").or(page.getByText("Stato cambiato")).first()).toBeVisible();
    await page.getByPlaceholder(/Write a note|Scrivi una nota/).fill("Please check @Mar");
    await page.getByRole("listbox").getByRole("button").first().click();
    await page.getByRole("button", { name: /Add note|Aggiungi nota/ }).click();
    await expect(page.locator("li", { hasText: "Please check" }).first()).toBeVisible();
    // reset to rules
    await page.getByRole("button", { name: /Change status|Cambia stato/ }).click();
    await page.getByRole("menuitem", { name: /Let rules decide|Lascia decidere/ }).click();
    await expect(page.getByText(/^manual$|^manuale$/)).toHaveCount(0);
  });

  test("viewer sees orders but no actions", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto("/t/northwind-apparel/orders");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("button", { name: /Change status|Cambia stato/ })).toHaveCount(0);
  });

  test("shipments page shows KPIs and the stuck view", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/shipments");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Shipments|Spedizioni/);
    await page.getByRole("button", { name: /^Stuck$|^Ferme$/ }).click();
    await expect(page).toHaveURL(/view=stuck/);
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });
});
