import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const SECRET = "demo-northwind-survey-secret-0001";
const sign = (id: string) => createHmac("sha256", SECRET).update(id).digest("hex");

test.describe("post-purchase survey", () => {
  test("a customer answers through the signed email link once; forged links are refused", async ({ page, browser }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/orders?status=delivered");
    const names = (await page.locator("table tbody tr td:first-child a").allInnerTexts()).map((n) => n.trim()).filter((n) => /^#NW-\d+$/.test(n)).slice(0, 10);
    const customer = await (await browser.newContext()).newPage();
    await customer.goto(`/s/northwind-apparel?o=5000000001&t=${"0".repeat(64)}&lang=en`);
    await expect(customer.getByTestId("survey-error")).toContainText(/not valid/);
    let answered = false;
    for (const name of names) {
      const id = String(5000000000 + Number(name.replace("#NW-", "")));
      await customer.goto(`/s/northwind-apparel?o=${id}&t=${sign(id)}&lang=en`);
      await expect(customer.getByTestId("survey-option").first().or(customer.getByTestId("survey-done"))).toBeVisible();
      if (await customer.getByTestId("survey-done").isVisible()) continue;
      await expect(customer.getByRole("heading", { level: 1 })).toHaveText("How did you first hear about us?");
      await customer.getByTestId("survey-option").filter({ hasText: "A podcast" }).click();
      await customer.getByTestId("survey-submit").click();
      await expect(customer.getByTestId("survey-done")).toContainText(/Thank you/);
      await customer.reload();
      await expect(customer.getByTestId("survey-done")).toContainText(/already/);
      answered = true;
      break;
    }
    expect(answered).toBe(true);
  });

  test("marketing reads the answers, the email link and the survey-blend attribution", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/analytics?tab=survey&preset=90d");
    await expect(page.getByTestId("survey-answer").first()).toBeVisible();
    await expect(page.getByTestId("survey-liquid")).toContainText("hmac_sha256");
    await expect(page.getByTestId("survey-settings")).toBeVisible();
    await page.goto("/t/northwind-apparel/analytics?tab=attribution&preset=90d&model=survey_blend&by=channel");
    await expect(page.getByText(/Word of mouth|Passaparola/).first()).toBeVisible();
  });
});
