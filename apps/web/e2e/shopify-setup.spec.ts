import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Issue #89: the merchant's self-serve Shopify setup lives on the card (mock mode). */
test.describe("Shopify self-serve setup", () => {
  test("the card shows the checklist with copy buttons, explains missing scopes, and connects the simulated store", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/integrations");
    // the setup lives in the card's Manage sheet (#90)
    await page.getByTestId("provider-shopify").getByTestId("shopify-manage").click();
    const card = page.getByTestId("integration-sheet");
    await card.getByTestId("shopify-setup-toggle").click();
    const setup = card.getByTestId("shopify-setup");
    await expect(setup.getByTestId("setup-step")).toHaveCount(5);
    await expect(setup.getByTestId("setup-copy-scopes_required")).toContainText("read_orders");
    await expect(setup.getByTestId("setup-copy-scopes_optional")).toContainText("read_returns");
    await expect(setup.getByTestId("setup-copy-redirect_url")).toContainText("/integrations/shopify/oauth/callback");
    await setup.getByTestId("setup-copy-button-scopes_required").click();
    await expect(setup.getByTestId("setup-copy-button-scopes_required")).toBeVisible();
    await expect(card.getByTestId("shopify-advanced")).toBeVisible();

    // a simulated app version without the order scopes: the error says which and how to add them
    const form = card.getByTestId("shopify-connect-form");
    await form.getByLabel(/Store domain|Dominio del negozio/).fill("harbor-home.myshopify.com");
    await form.getByLabel("Client ID").fill("missing-scopes-demo-app");
    await form.getByLabel("Client secret").fill("simulated-secret");
    await form.getByTestId("shopify-connect").click();
    const err = card.getByTestId("setup-error");
    await expect(err).toHaveAttribute("data-code", "missing_scopes");
    await expect(err).toContainText("read_orders");
    await expect(err).toContainText(/new version|nuova versione/);
    // what the merchant typed survives the failed attempt
    await expect(form.getByLabel(/Store domain|Dominio del negozio/)).toHaveValue("harbor-home.myshopify.com");
    await expect(form.getByLabel("Client ID")).toHaveValue("missing-scopes-demo-app");

    // a complete app connects the simulated store and the history import shows on the card
    await form.getByLabel("Client ID").fill("simulated-client-id");
    await form.getByLabel("Client secret").fill("simulated-secret");
    await form.getByTestId("shopify-connect").click();
    await expect(card.getByTestId("shopify-connected")).toBeVisible();
    await expect(card.getByTestId("history-import")).toBeVisible();
  });

  test("the guide renders the same steps, and the privacy webhooks refuse a bad signature", async ({ page, request }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/integrations/guide/shopify");
    await expect(page.getByTestId("guide-setup").getByTestId("setup-step")).toHaveCount(5);
    await expect(page.getByTestId("guide-setup").getByTestId("setup-copy-compliance_url")).toContainText("/webhooks/shopify/compliance");
    await expect(page.getByTestId("shopify-api-version")).toContainText("2026-10");
    const bad = await request.post("/api/webhooks/shopify/compliance", { headers: { "x-shopify-shop-domain": "harbor-demo.myshopify.com", "x-shopify-topic": "customers/redact", "x-shopify-hmac-sha256": "x" }, data: { shop_id: 1, customer: { id: 2 } } });
    expect(bad.status()).toBe(401);
  });
});
