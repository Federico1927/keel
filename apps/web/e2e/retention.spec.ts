import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("crm: customer campaigns with control group", () => {
  test("marketing reads a measured campaign, then creates and sends a new one", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/segments/campaigns");
    const rows = page.getByTestId("retention-row");
    await expect(rows.first()).toBeVisible();
    await page.getByRole("link", { name: /Win-back clienti ricorrenti/ }).click();
    await expect(page.getByTestId("groups-table")).toBeVisible();
    await expect(page.getByText(/^Effect \+|^Effetto \+/)).toBeVisible();
    await expect(page.getByText(/BACK10/).first()).toBeVisible();

    await page.goto("/t/northwind-apparel/segments/campaigns/new");
    const name = `E2E campaign ${Date.now()}`;
    await page.getByLabel(/^Name$|^Nome$/).fill(name);
    await expect(page.getByTestId("holdout-hint")).toContainText(/%/);
    await page.getByLabel(/^Message$|^Messaggio$/).fill("Ciao {first_name}");
    await page.getByLabel(/Attribution window|Finestra di attribuzione/).fill("7");
    await page.getByRole("button", { name: /Create draft|Crea bozza/ }).click();
    await expect(page).toHaveURL(/\/segments\/campaigns\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: /^Send…$|^Invia…$/ }).click();
    await expect(page.getByTestId("send-preview")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^Send now$|^Invia ora$/ }).click();
    await expect(page.getByTestId("groups-table")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Running|In corso/).first()).toBeVisible();
  });

  test("a viewer reads campaigns but cannot create or send", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto("/t/northwind-apparel/segments/campaigns");
    await expect(page.getByTestId("retention-row").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /New campaign|Nuova campagna/ })).toHaveCount(0);
    const res = await page.goto("/t/northwind-apparel/segments/campaigns/new");
    expect(res?.status()).toBe(404);
  });
});
