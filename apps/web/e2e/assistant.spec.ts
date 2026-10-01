import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

test.describe("AI assistant (addon.ai_studio)", () => {
  test("the owner reads the seeded conversation, its citation and its links", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.getByRole("link", { name: /^Assistant$|^Assistente$/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`${T}/assistant$`));
    await expect(page.getByTestId("assistant-mock-note")).toBeVisible();
    await page.getByTestId("assistant-threads").getByRole("link", { name: /Quali prodotti hanno venduto/ }).click();
    await expect(page.getByTestId("assistant-question")).toHaveText(/Quali prodotti hanno venduto di più/);
    const answer = page.getByTestId("assistant-answer");
    await expect(answer).toContainText(/il prodotto con più ricavi è/);
    const citation = answer.getByTestId("assistant-citation");
    await expect(citation).toHaveAttribute("data-tool", "get_top_products");
    await expect(citation.locator("tbody tr")).toHaveCount(5);
    await citation.getByTestId("citation-link").click();
    await expect(page).toHaveURL(/\/analytics\?tab=products&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });

  test("a question gets an answer with real figures, a follow-up continues the thread, and the thread can be deleted", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/assistant`);
    await page.getByTestId("assistant-input").fill("Come sono andati i ricavi negli ultimi 7 giorni?");
    await page.getByTestId("assistant-ask").click();
    await expect(page).toHaveURL(/\/assistant\?thread=/, { timeout: 30_000 });
    const answer = page.getByTestId("assistant-answer").last();
    await expect(answer).toContainText(/Ho consultato 1 fonte/);
    const kpis = answer.locator('[data-tool="get_kpis"]');
    await expect(kpis.getByTestId("citation-scope")).toContainText(/–/);
    await expect(kpis.getByText(/Ricavi netti|Net revenue/)).toBeVisible();
    await expect(kpis.getByTestId("citation-link")).toHaveAttribute("href", /\/analytics\?tab=overview&from=/);

    await page.getByTestId("assistant-input").fill("E quali campagne hanno perso soldi?");
    await page.getByTestId("assistant-ask").click();
    await expect(page.getByTestId("assistant-question")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("assistant-answer").last().locator('[data-tool="get_campaigns"]')).toBeVisible();
    await expect(page.getByTestId("assistant-usage")).toContainText(/Domande|Questions/);

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("assistant-delete").click();
    await expect(page).toHaveURL(new RegExp(`${T}/assistant$`));
    await expect(page.getByTestId("assistant-threads").getByText("Come sono andati i ricavi negli ultimi 7 giorni?")).toHaveCount(0);
  });

  test("customer care only gets the tools its role can read, and conversations are private", async ({ page }) => {
    await login(page, "care@northwind.demo");
    await page.goto(`${T}/assistant`);
    await expect(page.getByTestId("assistant-threads")).not.toContainText(/Quali prodotti/);
    const suggestions = page.getByTestId("assistant-suggestions");
    await expect(suggestions.getByRole("button")).toHaveCount(3);
    await suggestions.getByRole("button").first().click();
    await expect(page).toHaveURL(/\/assistant\?thread=/, { timeout: 30_000 });
    await expect(page.getByTestId("assistant-answer").last().getByTestId("assistant-citation").first()).toBeVisible();
  });

  test("without the add-on the page is unreachable", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await expect(page.getByRole("link", { name: /^Assistant$/ })).toHaveCount(0);
    const res = await page.goto("/t/harbor-home/assistant");
    expect(res?.status()).toBe(404);
  });
});
