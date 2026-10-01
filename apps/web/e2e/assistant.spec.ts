import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

test.describe("AI assistant (core, on the store's own Anthropic key)", () => {
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

  test("Harbor reads its English conversation; the Anthropic key is an integration with its guide", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/assistant");
    await page.getByTestId("assistant-threads").getByRole("link", { name: /Which products sold the most/ }).click();
    await expect(page.getByTestId("assistant-answer")).toContainText(/the product with the most revenue was/);
    await page.goto("/t/harbor-home/integrations");
    const card = page.getByTestId("provider-anthropic");
    await expect(card).toContainText("AI (Anthropic)");
    await expect(card.getByRole("button", { name: "Resync" })).toHaveCount(0);
    await card.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByTestId("msg-anthropic")).toContainText(/Mock model/);
    await card.getByRole("link", { name: "How to connect" }).click();
    await expect(page).toHaveURL(/\/integrations\/guide\/anthropic$/);
    await expect(page.getByTestId("guide-step")).toHaveCount(7);
  });

  test("a store without a key is asked to connect one", async ({ page }) => {
    await login(page, "superadmin@keel.demo");
    await page.goto("/admin/tenants/new");
    const stamp = Date.now().toString().slice(-6);
    await page.getByLabel(/Company name|Nome azienda/).fill(`AI Shop ${stamp}`);
    await page.getByLabel(/Country/).fill("IT");
    await page.getByLabel(/Currency|Valuta/).fill("EUR");
    await page.getByLabel(/Timezone|Fuso/).fill("Europe/Rome");
    await page.getByLabel(/Owner email|Email owner/).fill(`owner-ai-${stamp}@e2e.test`);
    await page.getByLabel(/Owner name|Nome owner/).fill("AI Owner");
    await page.getByRole("button", { name: /Create tenant|Crea tenant/ }).click();
    await expect(page.getByTestId("temp-password")).toBeVisible();
    // the super-admin opens the new store (impersonation, owner rights)
    await page.goto(`/t/ai-shop-${stamp}/assistant`);
    await expect(page.getByTestId("assistant-not-connected")).toBeVisible();
    await expect(page.getByTestId("assistant-input")).toHaveCount(0);
    await page.getByTestId("assistant-connect-link").click();
    await expect(page).toHaveURL(new RegExp(`/t/ai-shop-${stamp}/integrations$`));
  });
});
