import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("state rules page lists rules, previews recent orders and saves a new rule", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto("/t/northwind-apparel/settings/order-states");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Order state rules|Regole di stato ordine/);
  await expect(page.getByText(/Paid orders are confirmed/)).toBeVisible();
  await expect(page.getByText(/On the last 50 orders|Sugli ultimi 50 ordini/)).toBeVisible();
  await page.getByRole("button", { name: /Add rule|Aggiungi regola/ }).click();
  await page.getByLabel(/^Rule$|^Regola$/).fill("E2E preorder hold");
  await page.getByLabel(/Priority|Priorità/).fill("5");
  await page.getByLabel(/Any of these tags|Almeno uno di questi tag/).fill("preorder");
  await page.getByRole("dialog").getByRole("button", { name: /^Save$|^Salva$/ }).click();
  await expect(page.getByText("E2E preorder hold")).toBeVisible();
});
