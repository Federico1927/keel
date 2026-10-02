import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Issue #41: TikTok Ads as an ads platform — connection in mock mode, drill-down, pause confirmation, plan gating. */
test.describe("TikTok Ads", () => {
  test("owner connects the simulated TikTok account and sees campaigns, ad groups and ads", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    const card = page.getByTestId("provider-tiktok");
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /Test connection|Testa connessione/ })).toBeVisible();
    // the seed connects it: disconnect first so the connection flow runs from scratch
    const disconnect = card.getByRole("button", { name: /^Disconnect$|^Scollega$/ });
    if (await disconnect.count()) {
      await disconnect.click();
      await expect(card.getByText(/^Not connected$|^Non collegata$/)).toBeVisible();
    }
    await card.getByTestId("tiktok-mock-connect").click();
    await expect(page.getByTestId("msg-tiktok")).toContainText(/campaigns:6 ad_groups:11 ads:22/, { timeout: 60_000 });
    await expect(card.getByText(/^Connected$|^Collegata$/)).toBeVisible();
    await card.getByRole("button", { name: /Test connection|Testa connessione/ }).click();
    await expect(page.getByTestId("msg-tiktok")).toContainText(/Connection OK|Connessione OK/);
    await expect(page.getByTestId("sync-run-row").filter({ hasText: "tiktok/" }).first()).toBeVisible();

    await page.goto("/t/northwind-apparel/campaigns?preset=90d&platform=tiktok");
    await expect(page.getByRole("combobox", { name: /Platform|Piattaforma/ })).toHaveValue("tiktok");
    const rows = page.getByTestId("campaign-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId("declared-vs-real")).toContainText(/TikTok/);
    await rows.filter({ hasText: "Spark Ads" }).first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/);
    await expect(page.getByText(/^TIKTOK · /).first()).toBeVisible();
    await expect(page.getByTestId("ad-sets")).toContainText(/Ad groups|Gruppi di annunci/);
    const sets = page.getByTestId("ad-set-row");
    await expect(sets.first()).toBeVisible();
    await sets.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/adsets\/[0-9a-f-]{36}/);
    const ads = page.getByTestId("ad-row");
    await expect(ads.first()).toBeVisible();
    await ads.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/ads\/[0-9a-f-]{36}/);
    await expect(page.getByText(/utm_content=__CID__/).first()).toBeVisible();
    await expect(page.getByTestId("asset-row").first()).toContainText(/v10033g5/);
  });

  test("pausing a TikTok campaign asks for confirmation; the guide lists permissions and the UTM template", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=30d&platform=tiktok&status=active");
    await page.getByTestId("campaign-row").first().getByRole("link").first().click();
    await page.getByRole("button", { name: /Pause campaign|Spegni campagna/ }).click();
    await expect(page.getByRole("dialog")).toContainText(/TikTok Ads/);
    await page.getByRole("dialog").getByRole("button", { name: /Cancel|Annulla/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.goto("/t/northwind-apparel/integrations/guide/tiktok");
    expect(await page.getByTestId("guide-step").count()).toBeGreaterThanOrEqual(6);
    await expect(page.getByText(/To verify|Da verificare/).first()).toBeVisible();
    await expect(page.getByText("Ad Account Management, Ads Management, Reporting").first()).toBeVisible();
    await expect(page.getByText(/utm_content=__CID__&utm_term=__AID__/).first()).toBeVisible();
    await expect(page.getByTestId("tiktok-api-version")).toContainText("v1.3");
  });

  test("Harbor (Starter) cannot reach TikTok: locked card, no guide, no filter, no actions", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/integrations");
    const card = page.getByTestId("provider-tiktok");
    await expect(card).toHaveAttribute("data-locked", "true");
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card).toContainText(/Growth/);
    const guide = await page.goto("/t/harbor-home/integrations/guide/tiktok");
    expect(guide?.status()).toBe(404);
    await page.goto("/t/harbor-home/campaigns?platform=tiktok");
    const filter = page.getByRole("combobox", { name: /Platform|Piattaforma/ });
    await expect(filter).toHaveValue("");
    await expect(filter.locator("option[value=tiktok]")).toHaveCount(0);
    const oauth = await page.request.get("/api/integrations/tiktok/oauth/start?tenant=harbor-home", { maxRedirects: 0 });
    expect([404, 409, 501]).toContain(oauth.status());
  });
});
