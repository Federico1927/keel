import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("crm: customers, segments, rfm", () => {
  test("customers list searches, filters by tier and opens a detail with orders", async ({ page }) => {
    await login(page, "care@northwind.demo");
    await page.goto("/t/northwind-apparel/customers?sort=total_spent");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Customers|Clienti/);
    const rows = page.getByTestId("customer-row");
    await expect(rows.first()).toBeVisible();
    const email = (await rows.first().locator("div.text-xs").textContent())!.trim();
    await page.getByRole("textbox", { name: /Search|Cerca/ }).fill(email.slice(0, 10));
    await page.getByRole("textbox", { name: /Search|Cerca/ }).press("Enter");
    await expect(page).toHaveURL(/q=/);
    await expect(rows.first()).toContainText(email.slice(0, 10));
    await page.goto("/t/northwind-apparel/customers?tier=champions");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByText(/Champions|Campioni/)).toBeVisible();
    await rows.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/Sale orders|Ordini di vendita/)).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    await page.getByRole("link", { name: /Sale orders|Ordini di vendita/ }).click();
    await expect(page).toHaveURL(/\/orders\?customer=/);
  });

  test("marketing builds a nested segment, previews, saves with holdout, exports CSV and deletes it", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/segments");
    await expect(page.getByTestId("segment-row").first()).toBeVisible();
    await page.getByRole("link", { name: /New segment|Nuovo segmento/ }).click();
    await expect(page).toHaveURL(/\/segments\/new/);
    const name = `E2E nested ${Date.now()}`;
    await page.getByLabel(/^Name$|^Nome$/).fill(name);
    await page.getByLabel(/Holdout %|Controllo %/).fill("20");
    // default leaf: orders >= 2. Add a nested OR group with two conditions.
    const root = page.getByTestId("rule-group").first();
    await root.getByRole("button", { name: /^Group$|^Gruppo$/ }).first().click();
    const inner = page.getByTestId("rule-group").nth(1);
    await expect(inner).toBeVisible();
    await inner.getByLabel(/Match mode|Modalità/).selectOption("any");
    const innerLeaf = inner.getByTestId("rule-leaf").first();
    await innerLeaf.getByLabel(/^Field$|^Campo$/).selectOption("accepts_marketing");
    await inner.getByRole("button", { name: /^Condition$|^Condizione$/ }).click();
    const secondLeaf = inner.getByTestId("rule-leaf").nth(1);
    await secondLeaf.getByLabel(/^Field$|^Campo$/).selectOption("total_spent");
    await secondLeaf.getByLabel(/^Value$|^Valore$/).fill("150");
    await expect(page.getByText(/3\/30/)).toBeVisible();
    const count = page.getByTestId("preview-count");
    await expect(count).toBeVisible();
    await expect.poll(async () => Number((await count.textContent())!.replace(/[^\d]/g, ""))).toBeGreaterThan(0);
    await page.getByRole("button", { name: /Create segment|Crea segmento/ }).click();
    await expect(page).toHaveURL(/\/segments\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.getByTestId("member-row").first()).toBeVisible();
    await expect(page.getByText(/held out|gruppo di controllo/).first()).toBeVisible();
    const url = page.url();
    const res = await page.request.get(`${url}/export`);
    expect(res.status()).toBe(200);
    const csv = await res.text();
    expect(csv.split("\n")[0]).toContain("customer_id,first_name");
    expect(csv.split("\n").length).toBeGreaterThan(2);
    expect(csv).toMatch(/,holdout,/);
    await page.getByRole("button", { name: /^Delete$|^Elimina$/ }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: /^Delete$|^Elimina$/ }).click();
    await expect(page).toHaveURL(/\/segments$/);
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test("rfm matrix cell pre-fills a segment; viewer has no write controls", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/customers/rfm");
    await expect(page.getByRole("heading", { name: /^Recency × frequency$|^Recenza × frequenza$/ })).toBeVisible();
    await page.getByTestId("rfm-cell").first().click();
    await expect(page).toHaveURL(/\/segments\/new\?rules=/);
    await expect(page.getByTestId("rule-leaf")).toHaveCount(2);
    await expect(page.getByTestId("preview-count")).toBeVisible();

    await page.context().clearCookies();
    await login(page, "viewer@northwind.demo");
    await page.goto("/t/northwind-apparel/segments");
    await expect(page.getByTestId("segment-row").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /New segment|Nuovo segmento/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Re-evaluate|Rivaluta/ })).toHaveCount(0);
    const res = await page.goto("/t/northwind-apparel/segments/new");
    expect(res?.status()).toBe(404);
  });
});
