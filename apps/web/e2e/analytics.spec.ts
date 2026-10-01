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
    await expect(page.getByTestId("blended-card")).toContainText(/MER/);
    await expect(page.getByTestId("forecast-card")).toContainText(/Projected revenue|Ricavo previsto/);
    await page.getByRole("link", { name: /Sale orders|Ordini di vendita/ }).first().click();
    await expect(page).toHaveURL(/\/orders\?from=.*status=confirmed/);
  });

  test("owner enters period costs: the P/L switches from estimate to actual and says so", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/analytics?preset=mtd&tab=pnl");
    await expect(page.getByTestId("cost-sources")).toBeVisible();
    await page.getByRole("link", { name: /Enter period costs|Inserisci i costi di periodo/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Period costs|Costi di periodo/);
    const currentMonth = page.getByTestId("cost-month").filter({ hasText: /current month|mese corrente/ });
    await expect(currentMonth).toHaveCount(1);
    // shipping invoice for the current month → actual replaces the per-order estimate
    await currentMonth.getByTestId("cost-edit").first().click();
    await page.getByRole("dialog").getByLabel(/^Actual$|^Consuntivo$/).fill("1234.56");
    await page.getByRole("dialog").getByTestId("cost-save").click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
    await expect(currentMonth.getByText(/1[.,]?234[.,]56/).first()).toBeVisible();
    // a new fixed line for the current month
    await currentMonth.getByPlaceholder(/Rent, payroll|Affitto, personale/).fill("E2E consulting");
    await currentMonth.getByLabel(/^Estimate$|^Stima$/).last().fill("500");
    await currentMonth.getByTestId("cost-add").click();
    await expect(currentMonth.getByTestId("cost-line").filter({ hasText: "E2E consulting" })).toHaveCount(1);
    await page.goto("/t/northwind-apparel/analytics?preset=mtd&tab=pnl");
    await expect(page.getByTestId("cost-sources")).toContainText(/actual invoice|consuntivo da fattura/);
  });
});

test.describe("analytics depth", () => {
  test("attribution models, my dashboard with a custom metric, creatives and alerts", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    // attribution: switching model changes the credited numbers but keeps the comparison columns
    await page.goto("/t/northwind-apparel/analytics?preset=30d&tab=attribution");
    await expect(page.getByTestId("attribution-row").first()).toBeVisible();
    await page.getByTestId("model-first_click").click();
    await expect(page).toHaveURL(/model=first_click/);
    await expect(page.getByTestId("attribution-row").first()).toBeVisible();
    // custom metric + dashboard
    await page.goto("/t/northwind-apparel/analytics?preset=30d&tab=custom");
    await expect(page.getByTestId("my-dashboard")).toBeVisible();
    await page.getByLabel(/^Name$|^Nome$/).fill("E2E margin per order");
    await page.getByLabel(/^Formula$/).fill("contribution / orders");
    await page.getByTestId("save-metric").click();
    await expect(page.getByTestId("custom-metrics")).toContainText("E2E margin per order");
    await page.getByTestId("edit-dashboard").click();
    await page.getByTestId("metric-custom:e2e_margin_per_order").click();
    await page.getByTestId("save-dashboard").click();
    await expect(page.getByTestId("my-dashboard")).toContainText("E2E margin per order");
    // creatives grouped by format
    await page.goto("/t/northwind-apparel/campaigns/creatives?preset=90d");
    await expect(page.getByTestId("creative-row").first()).toBeVisible();
    await page.getByRole("link", { name: /^Format$|^Formato$/ }).click();
    await expect(page.getByTestId("creatives-table")).toContainText(/video|image|carousel/);
    // alerts: create a rule that fires, run now, see it in recent alerts
    await page.goto("/t/northwind-apparel/analytics/alerts");
    await expect(page.getByTestId("alert-rule").first()).toBeVisible();
    const ruleName = `E2E orders above zero ${Date.now()}`;
    await page.getByLabel(/^Name$|^Nome$/).fill(ruleName);
    await page.getByLabel(/^Metric$|^Metrica$/).selectOption("orders");
    await page.getByLabel(/^Kind$|^Tipo$/).selectOption("threshold");
    await page.getByLabel(/^Condition$|^Condizione$/).selectOption("gt");
    await page.getByLabel(/^Value$|^Valore$/).fill("-1");
    await page.getByTestId("save-alert").click();
    await expect(page.getByTestId("alert-rule").filter({ hasText: ruleName })).toHaveCount(1);
    await page.getByTestId("run-alerts").click();
    await expect(page.getByTestId("alert-events")).toContainText(ruleName);
  });
});
