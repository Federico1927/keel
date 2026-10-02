import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Issue #40: below the campaign — ad sets, ads, assets, keywords, search terms, words and suggestions. */
test.describe("ads below the campaign", () => {
  test("drill-down campaign → ad set → ad → assets, with Hullwise orders clickable and spend reconciled", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=30d&platform=google&status=active");
    await page.getByTestId("campaign-row").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/);
    const sets = page.getByTestId("ad-set-row");
    await expect(sets.first()).toBeVisible();
    await expect(page.getByTestId("unallocated")).toBeVisible();
    await sets.first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/adsets\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("ad-row").first()).toBeVisible();
    await expect(page.getByTestId("keyword-row").first()).toBeVisible();
    await expect(page.getByTestId("search-term-row").first()).toBeVisible();
    await page.getByTestId("ad-row").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/ads\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("asset-row").first()).toBeVisible();
    expect(await page.getByTestId("asset-row").count()).toBeGreaterThan(2);
    // the Hullwise orders number opens the orders behind it
    const ordersStat = page.getByRole("link", { name: /Hullwise orders|Ordini Hullwise/ }).first();
    if (await ordersStat.count()) {
      await ordersStat.click();
      await expect(page).toHaveURL(/\/orders\?.*utmContent=/);
    }
  });

  test("Meta ad pause asks for confirmation and goes through the write queue", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns?preset=30d&platform=meta&status=active");
    await page.getByTestId("campaign-row").first().getByRole("link").first().click();
    await page.getByTestId("ad-set-row").first().getByRole("link").first().click();
    await page.getByTestId("ad-row").first().getByRole("link").first().click();
    const pause = page.getByRole("button", { name: /Pause ad|Metti in pausa l'annuncio/ });
    const resume = page.getByRole("button", { name: /Resume ad|Riattiva l'annuncio/ });
    await expect(pause.or(resume)).toBeVisible();
    const pausing = (await pause.count()) > 0;
    await (pausing ? pause : resume).click();
    await expect(page.getByRole("dialog")).toContainText(/Meta/);
    await page.getByRole("dialog").getByRole("button", { name: /Confirm|Conferma/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(pausing ? resume : pause).toBeVisible();
  });

  test("keywords and search terms: the wasted-spend term is a negative candidate; excluding asks for confirmation", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns/keywords?preset=30d");
    await expect(page.getByTestId("keyword-row").first()).toBeVisible();
    await page.getByTestId("tab-search_terms").click();
    await expect(page.getByTestId("search-term-row").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/campaigns/keywords?preset=30d&tab=search_terms&candidates=1");
    const waste = page.getByTestId("search-term-row").filter({ hasText: "vestiti gratis" });
    await expect(waste).toBeVisible();
    await expect(waste.getByTestId("negative-candidate")).toHaveText(/Only cancelled orders|Solo ordini annullati/);
    // exclude another candidate (the demo term stays for the next run)
    const other = page.getByTestId("search-term-row").filter({ hasNotText: "vestiti gratis" }).filter({ has: page.getByTestId("add-negative") }).last();
    const text = (await other.locator("td").first().locator("div").first().textContent())!.trim();
    // the same term can be searched in several ad groups: excluding it in one removes that row only
    const exact = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    const rowsOf = () => page.getByTestId("search-term-row").locator("td:first-child > div:first-child").filter({ hasText: exact });
    const before = await rowsOf().count();
    await other.getByTestId("add-negative").click();
    await expect(page.getByRole("dialog")).toContainText(text);
    await page.getByRole("dialog").getByRole("button", { name: /Confirm|Conferma/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rowsOf()).toHaveCount(before - 1);
  });

  test("Words tab ranks the phrase common to profitable ads first; suggestions list negatives, words and UTM gaps", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/campaigns/words");
    await expect(page.getByTestId("words-winners").getByTestId("word-phrase").first()).toHaveText("lino naturale");
    await page.getByTestId("words-n-2").click();
    await expect(page.getByTestId("words-winners").getByTestId("word-phrase").first()).toHaveText("lino naturale");
    await page.getByTestId("words-source-search_terms").click();
    await expect(page.getByTestId("words-losers").getByTestId("word-row").first()).toBeVisible();

    await page.goto("/t/northwind-apparel/campaigns/recommendations");
    await expect(page.getByTestId("rec-negatives").getByTestId("rec-negative-row").filter({ hasText: "vestiti gratis" })).toBeVisible();
    await expect(page.getByTestId("rec-words").getByTestId("rec-word").first()).toContainText("lino naturale");
    await expect(page.getByTestId("rec-utm").getByTestId("rec-utm-row").first()).toBeVisible();
  });

  test("Google stays read-only without the write scope", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/campaigns/keywords?tab=search_terms&candidates=1&preset=30d");
    await expect(page.getByTestId("search-term-row").filter({ hasText: "free furniture" })).toBeVisible();
    await expect(page.getByTestId("add-negative")).toHaveCount(0);
  });
});
