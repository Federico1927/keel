import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Phone width (CLAUDE.md §7: a usable mobile view on every module). The page itself never scrolls
 * sideways; wide tables scroll inside their own containers.
 */
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 780 };
const BASE = "/t/northwind-apparel";
const PAGES = ["", "/orders", "/shipments", "/products", "/inventory", "/purchasing", "/customers", "/segments", "/campaigns", "/analytics", "/returns", "/discounts", "/integrations", "/assistant", "/settings", "/profile"];

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** First detail link of a list page (UUID route), so the check does not depend on seeded ids. */
async function firstDetail(page: Page, list: string): Promise<string> {
  await page.goto(`${BASE}${list}`);
  await expect(page.locator("main")).toBeVisible();
  const prefix = `${BASE}${list}/`;
  const href = await page.locator("main a[href]").evaluateAll(
    (links, p) => links.map((a) => a.getAttribute("href") ?? "").find((h) => h.startsWith(p) && /^[0-9a-f-]{36}$/.test(h.slice(p.length))),
    prefix,
  );
  expect(href, list).toBeTruthy();
  return href!;
}

test.describe("mobile layout", () => {
  test("main tenant pages do not scroll horizontally at 390px and 360px", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, "owner@northwind.demo");
    const paths = [...PAGES.map((p) => `${BASE}${p}`), await firstDetail(page, "/orders"), await firstDetail(page, "/products"), await firstDetail(page, "/customers")];
    for (const viewport of [PHONE, NARROW]) {
      await page.setViewportSize(viewport);
      for (const path of paths) {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        await expect(page.getByTestId("user-menu")).toBeInViewport({ ratio: 1 });
        expect(await horizontalOverflow(page), `${path} at ${viewport.width}px`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("the language choice lives in the user menu below sm, and in the header from sm up", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, "viewer@northwind.demo");
    await page.goto(`${BASE}/orders`);
    const picker = page.getByRole("combobox", { name: /Language|Lingua|Idioma/ });
    await expect(picker).toBeHidden();
    const original = (await page.locator("html").getAttribute("lang"))!;
    const other = original === "es" ? "en" : "es";
    await page.getByTestId("user-menu").click();
    await expect(page.getByTestId(`locale-${original}`)).toBeVisible();
    await page.getByTestId(`locale-${other}`).click();
    await expect(page.locator("html")).toHaveAttribute("lang", other);
    // restore the demo user's language
    await page.getByTestId(`locale-${original}`).click();
    await expect(page.locator("html")).toHaveAttribute("lang", original);
    await page.keyboard.press("Escape");
    // wider screens keep the header picker and do not repeat it in the menu
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(picker).toBeVisible();
    await page.getByTestId("user-menu").click();
    await expect(page.getByTestId("user-menu-language")).toBeHidden();
  });
});
