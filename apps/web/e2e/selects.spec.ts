import { expect, test, type Locator } from "@playwright/test";
import { login } from "./helpers";

/** The text line of a native select must fit inside its content box, or descenders get clipped. */
async function fits(select: Locator) {
  const m = await select.evaluate((el) => {
    const cs = getComputedStyle(el);
    const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return { inner, line: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2, font: parseFloat(cs.fontSize) };
  });
  expect(m.line, "line height fits the box").toBeLessThanOrEqual(m.inner + 0.5);
  expect(m.font * 1.2, "glyphs fit the box").toBeLessThanOrEqual(m.inner + 0.5);
}

test.describe("dropdowns are never clipped", () => {
  test("users role select and the language picker", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/users");
    const role = page.locator("main select").first();
    await expect(role).toBeVisible();
    await fits(role);
    await fits(page.getByRole("combobox", { name: /Language|Lingua|Idioma/ }));
  });

  test("admin plan select", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: "Harbor Home" }).first().click();
    const plan = page.locator('select[aria-label="plan"]');
    await expect(plan).toBeVisible();
    await fits(plan);
  });
});
