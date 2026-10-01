import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("crm: customer predictions", () => {
  test("marketing reads the model, recomputes, and turns a risk band into a segment", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/customers/predictions");
    await expect(page.getByTestId("risk-row")).toHaveCount(3);
    await expect(page.getByTestId("calibration")).toContainText(/MBG\/NBD/);
    await expect(page.getByTestId("top-value").locator("tbody tr").first()).toBeVisible();
    await page.getByRole("button", { name: /Recompute now|Ricalcola ora/ }).click();
    await expect(page.getByRole("button", { name: /Recompute now|Ricalcola ora/ })).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("risk-row")).toHaveCount(3);
    // the high-risk band opens the builder with the churn condition already set
    await page.getByTestId("risk-row").nth(2).getByRole("link", { name: /^Segment$|^Segmento$/ }).click();
    await expect(page).toHaveURL(/\/segments\/new\?rules=/);
    await expect(page.getByRole("combobox", { name: /Field|Campo/ }).first()).toHaveValue("churn_risk");
  });

  test("the customer list filters by churn risk and the detail shows the prediction", async ({ page }) => {
    await login(page, "care@northwind.demo");
    await page.goto("/t/northwind-apparel/customers?churn=low&sort=predicted_value");
    const rows = page.getByTestId("customer-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByText(/Low risk|Rischio basso/)).toBeVisible();
    await rows.first().getByRole("link").first().click();
    const card = page.getByTestId("prediction-card");
    await expect(card).toBeVisible();
    await expect(card.getByText(/Low risk|Rischio basso/)).toBeVisible();
    await expect(card.getByText(/Expected next order|Prossimo ordine atteso/)).toBeVisible();
  });
});
