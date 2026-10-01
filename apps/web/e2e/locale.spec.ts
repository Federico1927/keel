import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("language picker", () => {
  test("switching language changes the text and the date format, and is remembered on the profile", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/orders");
    const picker = page.getByRole("combobox", { name: /Language|Lingua|Idioma/ });
    await picker.selectOption("it");
    await expect(page.getByRole("heading", { name: "Ordini" })).toBeVisible();
    // dates follow the language on screen, not only the text
    await expect(page.locator("main")).toContainText(/\d{1,2} (gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic) \d{4}/);
    // remembered for the next sign-in
    await page.context().clearCookies();
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/orders");
    await expect(page.getByRole("heading", { name: "Ordini" })).toBeVisible();
    // restore the demo user's language
    await page.getByRole("combobox", { name: /Language|Lingua|Idioma/ }).selectOption("en");
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  });
});
