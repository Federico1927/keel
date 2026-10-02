import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Issue #90: every integration card connects by itself in mock mode — checklist with copy buttons and
 * "To verify" badges, a demo value that makes the simulator answer with a mapped error in plain words,
 * then the connected state with what the adapter found. Harbor keeps its seeded providers connected
 * (Meta, Google, AI, address, Shopify Subscriptions), Northwind its TikTok and Spoki.
 */

/** Opens the card's sheet (Connect or Manage) and its setup panel (behind "Reconnect" on a connected card). */
async function openSetup(page: Page, provider: string): Promise<Locator> {
  const card = page.getByTestId(`provider-${provider}`);
  const sheet = page.getByTestId("integration-sheet");
  if (!(await sheet.isVisible())) await card.getByTestId(await card.getByTestId(`${provider}-manage`).count() ? `${provider}-manage` : `${provider}-connect-open`).click();
  const panel = sheet.getByTestId(`${provider}-setup-panel`);
  if (!(await panel.isVisible())) await sheet.getByTestId(`${provider}-setup-toggle`).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function expectCopy(panel: Locator, id: string, text: string | RegExp) {
  await expect(panel.getByTestId(`setup-copy-${id}`)).toContainText(text);
  await panel.getByTestId(`setup-copy-button-${id}`).click();
  await expect(panel.getByTestId(`setup-copy-button-${id}`)).toBeVisible();
}

async function integrations(page: Page, email: string, slug: string) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  await login(page, email);
  await page.goto(`/t/${slug}/integrations`);
}

test.describe("integration self-setup (#90)", () => {
  test("every card has the same structure: one status pill, three meta rows, at most two buttons, simulations in one menu", async ({ page }) => {
    await integrations(page, "owner@northwind.demo", "northwind-apparel");
    const cards = page.getByTestId("integration-cards").locator(":scope > [data-testid^='provider-']");
    const n = await cards.count();
    expect(n).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      const id = await card.getAttribute("data-testid");
      await expect(card.locator("dt"), id!).toHaveCount(3);
      await expect(card.locator("[data-testid$='-status']"), id!).toHaveCount(1);
      expect(await card.locator("button:not([data-testid$='-simulate-menu'])").count(), id!).toBeLessThanOrEqual(2);
    }
    // the simulations are one menu, not stacked buttons
    const shopify = page.getByTestId("provider-shopify");
    await expect(shopify.getByRole("button", { name: /Simulate|Simula/ })).toHaveCount(0);
    await shopify.getByTestId("shopify-simulate-menu").click();
    await expect(page.getByRole("menuitem")).toHaveCount(4);
    await page.keyboard.press("Escape");
    // cards in a row share their height
    const boxes = await Promise.all([0, 1].map(async (i) => (await cards.nth(i).boundingBox())!));
    if (Math.abs(boxes[0]!.y - boxes[1]!.y) < 2) expect(Math.abs(boxes[0]!.height - boxes[1]!.height)).toBeLessThan(2);
  });

  test("Meta: token, ad accounts and pixel with each mapped error, then the accounts and campaigns found", async ({ page }) => {
    await integrations(page, "owner@harborhome.demo", "harbor-home");
    const panel = await openSetup(page, "meta");
    await expect(panel.getByTestId("setup-step")).toHaveCount(7);
    await expect(panel.getByText("To verify").first()).toBeVisible();
    await expectCopy(panel, "permissions", "ads_management");
    await expectCopy(panel, "utm_template", "utm_content={{ad.id}}");
    await expect(panel.getByTestId("setup-notes")).toContainText("Advantage+");
    await expect(panel.getByTestId("setup-mock-triggers")).toContainText("expired-token-demo");

    const form = panel.getByTestId("meta-connect-form");
    const connect = async () => form.getByTestId("meta-connect").click();
    await form.getByLabel("System user token").fill("expired-token-demo-0000000000");
    await form.getByLabel("Ad account ids").fill("act_123456789");
    await connect();
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "invalid_token");
    await expect(panel.getByTestId("setup-error")).toContainText("Generate a new token");
    // what the merchant typed survives the failed attempt
    await expect(form.getByLabel("Ad account ids")).toHaveValue("act_123456789");

    await form.getByLabel("System user token").fill("EAAB-simulated-system-user-token");
    await form.getByLabel("Ad account ids").fill("act_404404404");
    await connect();
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "account_not_assigned");
    await expect(panel.getByTestId("setup-error")).toContainText("Assign assets");

    await form.getByLabel("Ad account ids").fill("act_123456789");
    await form.getByLabel(/Pixel \(dataset\) id/).fill("404404404");
    await connect();
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "pixel_not_accessible");

    await form.getByLabel(/Pixel \(dataset\) id/).fill("");
    await connect();
    await expect(panel.getByTestId("setup-verified")).toContainText(/Found \d+ ad accounts? .* campaigns?/);
    // Harbor's seeded pixel (Conversions API destination) is kept when the field is left empty
    await expect(panel.getByTestId("setup-verified")).toContainText(/Found 1 ad account \(.*\) with \d+ campaigns?.*Pixel/);
    await expect(panel.getByTestId("setup-error")).toHaveCount(0);
  });

  test("Google Ads: a refused sign-in, an account that cannot be read, then the picked account", async ({ page }) => {
    await integrations(page, "owner@harborhome.demo", "harbor-home");
    let panel = await openSetup(page, "google");
    await expect(panel.getByTestId("setup-step")).toHaveCount(6);
    await expectCopy(panel, "redirect_url", "/integrations/google/oauth/callback");
    await expectCopy(panel, "scope", "auth/adwords");
    await expect(panel.getByTestId("google-advanced")).toBeVisible();

    // the merchant refuses the consent: Google sends them back with access_denied
    await panel.getByTestId("google-mock-deny").click();
    await expect(page).toHaveURL(/setup_error=access_denied/);
    // back from the redirect the sheet opens by itself on the error
    panel = page.getByTestId("integration-sheet").getByTestId("google-setup-panel");
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "access_denied");

    // the simulated sign-in lists the accounts, one under an agency's manager account
    await panel.getByTestId("google-oauth").click();
    await expect(page).toHaveURL(/setup=google/);
    panel = page.getByTestId("integration-sheet").getByTestId("google-setup-panel");
    const picker = panel.getByTestId("google-account-picker");
    await expect(picker.locator("optgroup")).toHaveCount(1);
    await picker.getByLabel("Choose the Google Ads account").selectOption("1111111111");
    await picker.getByTestId("google-account-pick").click();
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "not_enabled");
    await picker.getByLabel("Choose the Google Ads account").selectOption("4815162342");
    await picker.getByTestId("google-account-pick").click();
    await expect(panel.getByTestId("setup-verified")).toContainText(/Connected to Harbor Home: \d+ campaigns? found/);
    await expect(page.getByTestId("provider-google").getByTestId("google-status")).toHaveText("Connected");
  });

  test("AI assistant and address validation: key errors in plain words, then what the key returned", async ({ page }) => {
    await integrations(page, "owner@harborhome.demo", "harbor-home");
    const ai = page.getByTestId("provider-anthropic");
    let panel = await openSetup(page, "anthropic");
    await expect(panel.getByTestId("setup-step")).toHaveCount(5);
    await expectCopy(panel, "console_url", "console.anthropic.com");
    const key = panel.getByLabel("Anthropic API key");
    await key.fill("sk-ant-no-credit-demo-0000");
    await panel.getByTestId("anthropic-connect").click();
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "no_credit");
    await expect(panel.getByTestId("setup-error")).toContainText("Settings → Billing");
    await key.fill("sk-ant-api03-simulated-key-0000");
    await panel.getByTestId("anthropic-connect").click();
    await expect(panel.getByTestId("setup-verified")).toContainText("Mock model answered");
    await page.keyboard.press("Escape");
    // Test connection on the card shows what the key returned too
    await ai.getByRole("button", { name: "Test connection" }).click();
    await expect(ai.getByTestId("setup-verified")).toContainText("The key works");

    panel = await openSetup(page, "address");
    await expect(panel.getByTestId("setup-step")).toHaveCount(6);
    await expectCopy(panel, "apis", "places.googleapis.com");
    await panel.getByLabel("Google API key").fill("AIza-key-restricted-demo-00000");
    await panel.getByTestId("address-connect").click();
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "key_restricted");
    await expect(panel.getByTestId("setup-error")).toContainText("Application restrictions must be None");
    await panel.getByLabel("Google API key").fill("AIza-simulated-maps-key-000000");
    await panel.getByTestId("address-connect").click();
    await expect(panel.getByTestId("setup-verified")).toContainText("test search returned");
  });

  test("subscription apps: a Recharge token without scopes, then Shopify Subscriptions through the Shopify connection", async ({ page }) => {
    await integrations(page, "owner@harborhome.demo", "harbor-home");
    await page.getByTestId("provider-subscriptions").getByTestId("subscriptions-manage").click();
    const card = page.getByTestId("integration-sheet");
    if (!(await card.getByTestId("subs-setup").isVisible())) await card.getByTestId("subs-setup-toggle").click();
    await card.getByLabel("Subscription app").selectOption("recharge");
    const recharge = card.getByTestId("recharge-setup-panel");
    await expect(recharge.getByTestId("setup-step")).toHaveCount(5);
    await expectCopy(recharge, "webhook_url", "/webhooks/subscriptions/");
    await recharge.getByLabel("API token").fill("missing-scopes-demo-token-000");
    await recharge.getByLabel("Webhook signing secret").fill("whsec-simulated");
    await recharge.getByTestId("recharge-connect").click();
    await expect(recharge.getByTestId("setup-error")).toHaveAttribute("data-code", "missing_scopes");

    await card.getByLabel("Subscription app").selectOption("shopify_subscriptions");
    const shopify = card.getByTestId("shopify_subscriptions-setup-panel");
    await expectCopy(shopify, "scopes", "read_own_subscription_contracts");
    await shopify.getByTestId("shopify_subscriptions-connect").click();
    await expect(shopify.getByTestId("setup-verified")).toContainText(/Connected: .*subscription/);
  });

  test("TikTok and Spoki (Northwind): a refused authorization and a rejected key, then connected", async ({ page }) => {
    await integrations(page, "owner@northwind.demo", "northwind-apparel");
    const tiktok = page.getByTestId("provider-tiktok");
    const sheet = page.getByTestId("integration-sheet");
    if (await tiktok.getByTestId("tiktok-manage").count()) {
      await tiktok.getByTestId("tiktok-manage").click();
      await sheet.getByTestId("tiktok-disconnect").click();
      await expect(tiktok.getByTestId("tiktok-status")).toHaveText(/^Not connected$|^Non collegata$/);
    } else await tiktok.getByTestId("tiktok-connect-open").click();
    let panel = sheet.getByTestId("tiktok-setup-panel");
    await expect(panel.getByTestId("setup-step")).toHaveCount(4);
    await expectCopy(panel, "utm_template", "utm_content=__CID__");
    await panel.getByTestId("tiktok-mock-deny").click();
    await expect(page).toHaveURL(/setup_error=access_denied/);
    panel = page.getByTestId("integration-sheet").getByTestId("tiktok-setup-panel");
    await expect(panel.getByTestId("setup-error")).toHaveAttribute("data-code", "access_denied");
    await panel.getByTestId("tiktok-mock-connect").click();
    await expect(page.getByTestId("msg-tiktok")).toContainText(/campaigns:\d+/, { timeout: 60_000 });
    await expect(page.getByTestId("integration-sheet").getByTestId("setup-verified")).toBeVisible();
    await expect(tiktok.getByTestId("tiktok-status")).toHaveText(/^Connected$|^Collegata$/);
    await page.keyboard.press("Escape");

    const sp = await openSetup(page, "spoki");
    await expect(sp.getByTestId("setup-step")).toHaveCount(5);
    await expectCopy(sp, "webhook_url", "/webhooks/spoki/");
    await sp.getByLabel(/Spoki API key|Chiave API Spoki/).fill("invalid-key-demo-000000000000");
    await sp.getByTestId("spoki-connect").click();
    await expect(sp.getByTestId("setup-error")).toHaveAttribute("data-code", "invalid_key");
    await sp.getByLabel(/Spoki API key|Chiave API Spoki/).fill("simulated-spoki-key-0000000000");
    await sp.getByTestId("spoki-connect").click();
    await expect(sp.getByTestId("setup-verified")).toContainText(/template/);
  });

  test("GA4 keeps its checklist; the guides render the same definitions with the owner prerequisite", async ({ page }) => {
    await integrations(page, "owner@harborhome.demo", "harbor-home");
    const ga4 = page.getByTestId("provider-ga4");
    await ga4.getByTestId("ga4-connect-open").click();
    const sheet = page.getByTestId("integration-sheet");
    await expect(sheet.getByTestId("setup-step")).toHaveCount(6);
    await expect(sheet.getByTestId("setup-copy-button-serviceAccountEmail")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/t/harbor-home/integrations/guide/meta");
    const meta = page.getByTestId("guide-setup");
    await expect(meta.getByTestId("setup-step")).toHaveCount(7);
    await expect(meta.getByTestId("setup-notes")).toContainText("Continue with Facebook");
    await page.goto("/t/harbor-home/integrations/guide/google");
    await expect(page.getByTestId("guide-setup").getByTestId("setup-copy-redirect_url")).toContainText("/integrations/google/oauth/callback");
    await expect(page.getByTestId("guide-owner-prerequisite")).toBeVisible();
    await page.goto("/t/harbor-home/integrations/guide/subscriptions");
    await expect(page.getByTestId("guide-setup")).toHaveCount(3);
    await page.goto("/t/harbor-home/integrations/guide/ga4");
    await expect(page.getByTestId("guide-setup").getByTestId("setup-copy-serviceAccountEmail")).toContainText("iam.gserviceaccount.com");
    await expect(page.locator("main")).not.toContainText("{product}");
  });
});
