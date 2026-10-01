import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

test.describe("inventory planning", () => {
  test("reorder tab creates draft purchase orders per supplier", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/inventory`);
    await page.getByTestId("planning-link").click();
    await expect(page).toHaveURL(/\/inventory\/planning/);
    await expect(page.getByTestId("replenishment-row").first()).toBeVisible();
    const generate = page.getByTestId("generate-drafts");
    if (await generate.isEnabled()) {
      await generate.click();
      await expect(page.getByTestId("drafts-result")).toBeVisible();
      await page.reload();
    }
    // after a run (this one or an earlier one) the suggested variants show their open draft quantity
    await expect(page.getByText(/\d+ in draft|\d+ in bozza/).first()).toBeVisible();
    await expect(page.getByTestId("generate-drafts")).toBeDisabled();
  });

  test("forecast, analysis, transfers, cash flow, target and bundles render with data", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/inventory/planning?tab=forecast`);
    await expect(page.locator(".recharts-responsive-container").first()).toBeVisible();
    await expect(page.getByTestId("demand-events").locator("li").first()).toContainText(/Black Friday/);
    await page.goto(`${T}/inventory/planning?tab=analysis`);
    await expect(page.getByTestId("abc-xyz")).toBeVisible();
    await page.goto(`${T}/inventory/planning?tab=transfers`);
    await expect(page.getByTestId("transfer-row").first()).toBeVisible();
    await page.goto(`${T}/inventory/planning?tab=cashflow`);
    await expect(page.getByTestId("cash-month").first()).toBeVisible();
    await page.goto(`${T}/inventory/planning?tab=target&target=500000&months=3`);
    await expect(page.getByTestId("target-row").first()).toBeVisible();
    await page.goto(`${T}/inventory/planning?tab=bundles`);
    await expect(page.getByTestId("bundle-card")).toHaveCount(2);
  });

  test("landed cost, PDF and supplier confirmation through the public link", async ({ page, browser }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/purchasing?status=draft`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
    const poUrl = page.url();
    // landed cost
    const card = page.getByTestId("landed-cost-card");
    await card.getByLabel(/Amount|Importo/).fill("120");
    await card.getByRole("button", { name: /Add charge|Aggiungi costo/ }).click();
    await expect(card.getByText(/Freight|Trasporto/).first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Landed/ })).toBeVisible();
    // PDF
    const pdf = await page.request.get(`${poUrl}/pdf`);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    // send to supplier
    await page.getByTestId("po-send").click();
    const link = await page.getByTestId("supplier-link").inputValue();
    expect(link).toMatch(/\/supplier\/po\/[A-Za-z0-9_-]{20,}$/);
    // the supplier opens it without an account
    const supplier = await browser.newContext();
    const sp = await supplier.newPage();
    await sp.goto(`${new URL(link).pathname}?lang=en`);
    await expect(sp.getByTestId("supplier-po-status")).toHaveText(/Waiting for your confirmation/);
    await sp.getByLabel(/Note/).fill("Ships next week");
    await sp.getByTestId("supplier-ack-submit").click();
    await expect(sp.getByTestId("supplier-ack-done")).toBeVisible();
    await supplier.close();
    // the team sees the answer
    await page.reload();
    await expect(page.getByText(/^Confirmed$|^Confermato$/).first()).toBeVisible();
    await expect(page.getByTestId("supplier-card")).toContainText("Ships next week");
  });

  test("an unknown supplier link is a 404", async ({ page }) => {
    const res = await page.goto("/supplier/po/not-a-real-token-1234567890");
    expect(res?.status()).toBe(404);
  });

  test("supplier terms can be edited", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/purchasing/suppliers`);
    await page.locator('[data-testid^="edit-supplier-"]').first().click();
    const form = page.getByTestId("supplier-form");
    await expect(form.locator('input[name="id"]')).toHaveCount(1);
    await form.getByLabel(/Deposit|Acconto/).fill("25");
    await form.getByRole("button", { name: /^Save$|^Salva$/ }).click();
    await expect(form.getByText(/Saved|Salvato/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/25% deposit|Acconto 25%/).first()).toBeVisible();
  });
});
