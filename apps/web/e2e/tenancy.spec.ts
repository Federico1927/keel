import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("tenancy and permissions", () => {
  test("owner sees settings, users and audit; can save settings", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/settings");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Settings|Impostazioni/);
    await page.getByRole("button", { name: /^save$|^salva$/i }).first().click();
    await expect(page.getByText(/Saved\.|Salvato\./)).toBeVisible();
    await page.goto("/t/northwind-apparel/users");
    await expect(page.getByText("owner@northwind.demo")).toBeVisible();
    await page.goto("/t/northwind-apparel/audit");
    await expect(page.getByText("tenant.settings.general_updated").first()).toBeVisible();
  });

  test("viewer cannot open users or settings, even by URL", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    const res = await page.goto("/t/northwind-apparel/users");
    expect(res?.status()).toBe(404);
    const res2 = await page.goto("/t/northwind-apparel/settings");
    expect(res2?.status()).toBe(404);
  });

  test("a user cannot open a tenant they do not belong to", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    const res = await page.goto("/t/northwind-apparel");
    expect(res?.status()).toBe(404);
  });

  test("a disabled add-on page is unreachable by URL", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home");
    await expect(page.locator("nav").first()).not.toContainText(/COD queue|Coda contrassegno/);
    const res = await page.goto("/t/harbor-home/cod");
    expect(res?.status()).toBe(404);
  });

  test("multi-tenant user can switch workspace", async ({ page }) => {
    await login(page, "multi@keel.demo");
    await page.goto("/t/harbor-home");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/t/northwind-apparel");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
