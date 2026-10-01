import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Direction A themes (#44). The theme class is rendered by the server from the user's saved
 * preference, so the very first HTML already carries it: no flash of the wrong theme. A dedicated
 * demo user keeps the other specs' sessions and preferences untouched.
 */
const USER = "marketing@harborhome.demo";
const BASE = "/t/harbor-home";
const PAGES = ["", "/campaigns", "/customers", "/segments", "/analytics", "/discounts", "/profile"];

async function setTheme(page: Page, theme: "light" | "dark" | "system") {
  await page.getByTestId("user-menu").click();
  await page.getByTestId(`theme-${theme}`).click();
  await page.keyboard.press("Escape");
}

/** The <html> start tag exactly as the server sent it, before any script ran. */
async function serverHtmlTag(page: Page, path: string): Promise<string> {
  const res = await page.request.get(path);
  expect(res.ok()).toBeTruthy();
  return (await res.text()).match(/<html[^>]*>/)![0];
}

test.describe("theme", () => {
  test("dark is rendered by the server on every main page, with dark tokens and no flash", async ({ page }) => {
    await login(page, USER);
    await page.goto(BASE);
    await setTheme(page, "dark");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    for (const path of PAGES) {
      const tag = await serverHtmlTag(page, `${BASE}${path}`);
      expect(tag, path).toMatch(/class="[^"]*\bdark\b/);
      expect(tag, path).toContain('data-theme="dark"');
      await page.goto(`${BASE}${path}`);
      await expect(page.locator("main")).toBeVisible();
      // the body paints with the dark background token (#0b0d12)
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), path).toBe("rgb(11, 13, 18)");
    }
    // tenant-branded public pages keep their light look inside a dark app session
    await page.goto("/r/harbor-home");
    expect(await page.locator("main.light").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(247, 248, 250)");
    await page.goto(BASE);
    await setTheme(page, "light");
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    expect(await serverHtmlTag(page, BASE)).not.toMatch(/class="[^"]*\bdark\b/);
    await setTheme(page, "system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  });

  test("system follows the device before the first paint, signed out too", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        (window as unknown as { darkAtDcl: boolean }).darkAtDcl = document.documentElement.classList.contains("dark");
      });
    });
    await page.goto("/login");
    expect(await page.evaluate(() => (window as unknown as { darkAtDcl: boolean }).darkAtDcl)).toBe(true);
    await login(page, USER);
    await page.goto(BASE);
    if ((await page.locator("html").getAttribute("data-theme")) !== "system") {
      await setTheme(page, "system");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
      await page.reload();
    }
    expect(await page.evaluate(() => (window as unknown as { darkAtDcl: boolean }).darkAtDcl)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    await context.close();
  });

  test("the fonts are self-hosted Geist", async ({ page }) => {
    await page.goto("/login");
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toMatch(/Geist/);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => [...document.fonts].some((f) => /Geist/.test(f.family) && f.status === "loaded"))).toBe(true);
  });
});
