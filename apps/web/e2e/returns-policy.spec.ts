import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

test.describe("return policy and automations", () => {
  test("the team edits windows, exclusions and automations, and they persist", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/returns`);
    await page.getByTestId("policy-link").click();
    const form = page.getByTestId("return-policy-form");
    await expect(form.getByTestId("policy-window").first()).toBeVisible();
    await expect(form.getByTestId("policy-automation")).toHaveCount(3);
    const prefix = `E2E${Date.now().toString(36).toUpperCase()}-`;
    await form.getByLabel(/SKU prefixes|Prefissi SKU/).fill(`GIFT-, ${prefix}`);
    await form.getByTestId("add-automation").click();
    const added = form.getByTestId("policy-automation").last();
    // harmless while other tests create returns: only flags returns above an amount no test reaches
    await added.getByLabel(/^Name$|^Nome$/).fill("E2E flag very large");
    await added.getByLabel(/^Action$|^Azione$/).selectOption("flag");
    await added.getByLabel(/From \(|Da \(/).fill("99999");
    await page.getByTestId("policy-save").click();
    await expect(form.getByText(/Saved|Salvato/)).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/SKU prefixes|Prefissi SKU/)).toHaveValue(`GIFT-, ${prefix}`);
    await expect(page.getByTestId("policy-automation")).toHaveCount(4);
    // remove the test automation so the demo keeps its three rules
    await page.getByTestId("policy-automation").last().getByRole("button", { name: /Delete|Elimina/ }).click();
    await page.getByLabel(/SKU prefixes|Prefissi SKU/).fill("GIFT-");
    await page.getByTestId("policy-save").click();
    await expect(page.getByTestId("return-policy-form").getByText(/Saved|Salvato/)).toBeVisible();
  });

  test("flagged returns show the customer risk and the automation, and can be marked as reviewed", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/returns`);
    await page.getByTestId("filter-review").click();
    await expect(page).toHaveURL(/review=1/);
    await page.getByTestId("return-row").first().getByRole("link").first().click();
    await expect(page.getByTestId("return-review-badge")).toBeVisible();
    await expect(page.getByTestId("return-risk")).toBeVisible();
    await expect(page.getByTestId("return-automations")).toContainText(/risk|rischio/i);
    await page.getByTestId("return-review-toggle").click();
    await expect(page.getByTestId("return-review-badge")).toHaveCount(0);
  });
});
