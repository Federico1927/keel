import { expect, test } from "@playwright/test";

const titles: Record<string, string> = { en: "Sign in", it: "Accedi", es: "Iniciar sesión" };

for (const [locale, title] of Object.entries(titles)) {
  test(`login page renders in ${locale}`, async ({ page, context }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: "http://localhost:3000" }]);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  });
}

test("password login reaches the tenant home", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@northwind.demo");
  await page.getByLabel("Password").fill("hullwise-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/t\/northwind-apparel/);
});
