import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Issue #7, last block: address validation card and guide, activation guides of the ad hoc integrations, return status email switches. */
const AD_HOC = ["payment_guarantee", "return_labels", "audiences", "messaging", "carrier", "warehouse"] as const;

test.describe("external integrations", () => {
  test("address validation: simulated provider connected, connection test, key form and guide with the Google APIs", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    const card = page.getByTestId("provider-address");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Simulated address provider");
    await card.getByRole("button", { name: /Test connection|Testa connessione/ }).click();
    await expect(page.getByTestId("msg-address")).toContainText(/Connection OK|Connessione OK/);
    await card.getByRole("button", { name: /^Connect$|^Collega$/ }).click();
    await expect(card.getByLabel(/Google API key|Chiave API Google/)).toBeVisible();

    await card.getByRole("link", { name: /How to connect|Come collegarla/ }).click();
    await expect(page).toHaveURL(/\/integrations\/guide\/address$/);
    expect(await page.getByTestId("guide-step").count()).toBeGreaterThanOrEqual(6);
    await expect(page.getByText(/To verify|Da verificare/).first()).toBeVisible();
    await expect(page.getByTestId("address-apis")).toContainText("addressvalidation.googleapis.com");
    await expect(page.getByTestId("ad-hoc-notice")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("{product}");
  });

  test("every ad hoc integration has an activation guide with the activation notice, linked from the integrations page", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    for (const k of AD_HOC) await expect(page.getByTestId(`slot-${k}`)).toBeVisible();
    await page.getByTestId("slot-payment_guarantee").getByRole("link").click();
    await expect(page).toHaveURL(/\/integrations\/guide\/payment_guarantee$/);
    for (const k of AD_HOC) {
      await page.goto(`/t/northwind-apparel/integrations/guide/${k}`);
      await expect(page.getByTestId("ad-hoc-notice"), k).toBeVisible();
      expect(await page.getByTestId("guide-step").count(), k).toBeGreaterThanOrEqual(5);
      await expect(page.getByText(/To verify|Da verificare/).first(), k).toBeVisible();
      await expect(page.locator("[data-testid=guide-ad-hoc-nav] a[aria-current=page]"), k).toHaveCount(1);
      await expect(page.locator("main"), k).not.toContainText("{product}");
    }
  });

  test("guides read in English for an English store", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/integrations/guide/carrier");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Carrier tracking and delivery instructions");
    await expect(page.getByTestId("ad-hoc-notice")).toContainText("Ad hoc integration");
    await page.goto("/t/harbor-home/integrations/guide/address");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Address validation (Google)");
  });

  test("returns: the customer status emails are on in the demo and each one can be switched off", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/returns/portal");
    const box = page.getByTestId("customer-emails");
    const boxes = box.locator("input[type=checkbox]");
    await expect(boxes).toHaveCount(5);
    for (let i = 0; i < 5; i++) await expect(boxes.nth(i)).toBeChecked();
    const exchange = box.locator("input[name=email-exchange_shipped]");
    await exchange.uncheck();
    await page.getByTestId("behaviour-save").click();
    await expect(page.getByTestId("return-behaviour-form").getByText(/Saved|Salvat/)).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("customer-emails").locator("input[name=email-exchange_shipped]")).not.toBeChecked();
    await page.getByTestId("customer-emails").locator("input[name=email-exchange_shipped]").check();
    await page.getByTestId("behaviour-save").click();
    await expect(page.getByTestId("return-behaviour-form").getByText(/Saved|Salvat/)).toBeVisible();
  });
});
