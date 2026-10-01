import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// The demo seed leaves one product without cost (and the orders that sold it), a few variants without
// barcode and one duplicate SKU. These specs edit and import costs on a product that already has one,
// so the missing-cost demo stays in place across runs.
const T = "/t/northwind-apparel";

test.describe("product cost and catalog data quality", () => {
  test("dashboard counts the catalog gaps and the P/L links its missing-cost warning to the filtered orders", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(T);
    await page.getByRole("link", { name: /Variants without cost or SKU|Varianti senza costo o SKU/ }).click();
    await expect(page).toHaveURL(/\/products\/quality\?issue=missing_cost/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Catalog data quality|Qualità dati del catalogo/);
    await expect(page.getByTestId("quality-row").first()).toBeVisible();
    await page.goto(`${T}/products/quality?issue=duplicate_sku`);
    await expect(page.getByTestId("quality-row")).toHaveCount(2);

    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    await page.goto(`${T}/analytics?tab=pnl&from=${from}&to=${to}`);
    await expect(page.getByTestId("cost-reliability")).toContainText(/%/);
    const warning = page.getByTestId("cogs-incomplete");
    await expect(warning).toContainText(/orders contain products without cost|ordini contengono prodotti senza costo/);
    await warning.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/orders\?.*missingCost=1/);
    await expect(page.getByTestId("filter-missing-cost")).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("operations edits the cost of every variant of a product; the source becomes manual", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/products/quality?issue=missing_barcode`);
    await page.getByTestId("quality-row").first().getByRole("link").first().click();
    const card = page.getByTestId("variant-costs");
    await expect(card).toBeVisible();
    const first = card.getByTestId("cost-input").first();
    const next = (await first.inputValue()) === "12.34" ? "12.35" : "12.34";
    await card.getByTestId("cost-bulk").fill(next);
    await card.getByRole("button", { name: /Use for all variants|Usa per tutte le varianti/ }).click();
    await expect(first).toHaveValue(next);
    await card.getByTestId("cost-save").click();
    await expect(card.getByTestId("cost-result")).toContainText(/saved|salvat/);
    await page.reload();
    await expect(page.getByTestId("variant-costs").getByText(/Entered by hand|Inserito a mano/).first()).toBeVisible();
  });

  test("the CSV import previews unmatched rows, writes nothing until confirmed, then imports", async ({ page, context }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/products/quality?issue=missing_barcode`);
    const productHref = await page.getByTestId("quality-row").first().getByRole("link").first().getAttribute("href");
    const sku = (await page.getByTestId("quality-row").first().locator("td").nth(1).innerText()).trim();
    await page.goto(productHref!);
    const input = (p: typeof page) => p.getByTestId("cost-row").filter({ hasText: sku }).getByTestId("cost-input");
    const before = await input(page).inputValue();
    const target = before === "21.00" ? "22.00" : "21.00";

    await page.goto(`${T}/products/import-costs`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Import product costs|Importa costi prodotto/);
    await page.getByTestId("cost-file").setInputFiles({ name: "costs.csv", mimeType: "text/csv", buffer: Buffer.from(`sku;cost\n${sku};${target.replace(".", ",")}\nNOPE-E2E-404;3\n${sku}X;abc\n`) });
    await page.getByTestId("cost-preview").click();
    await expect(page.getByTestId("cost-preview-result")).toBeVisible();
    await expect(page.getByTestId("preview-unmatched")).toContainText("NOPE-E2E-404");
    await expect(page.getByTestId("preview-matched")).toContainText(sku);
    await expect(page.getByTestId("preview-invalid")).toHaveCount(1);

    // nothing written yet
    const other = await context.newPage();
    await other.goto(productHref!);
    await expect(input(other)).toHaveValue(before);

    await page.getByTestId("cost-confirm").click();
    await expect(page.getByTestId("cost-import-message")).toContainText(/imported|importat/);
    await other.reload();
    await expect(input(other)).toHaveValue(target);
    await expect(other.getByTestId("cost-row").filter({ hasText: sku }).getByText(/CSV import|Import CSV/)).toBeVisible();
  });

  test("roles without write access on products cannot reach the import", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    const res = await page.goto(`${T}/products/import-costs`);
    expect(res?.status()).toBe(404);
    await page.goto(`${T}/products/quality`);
    await expect(page.getByTestId("import-costs-link")).toHaveCount(0);
  });
});
