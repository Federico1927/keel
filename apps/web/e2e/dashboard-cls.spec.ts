import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Layout stability of the tenant home: the widgets stream in behind Suspense fallbacks and the charts load
 * on demand, so every fallback must hold the final size. Measured like Lighthouse's CLS: the sum of the
 * `layout-shift` entries without recent input (PerformanceObserver, buffered from the start of the page).
 */
declare global {
  interface Window {
    __cls?: { total: number; shifts: { value: number; sources: string[] }[] };
  }
}

async function measureHome(page: Page, slug: string): Promise<{ total: number; shifts: { value: number; sources: string[] }[] }> {
  await page.addInitScript(() => {
    window.__cls = { total: 0, shifts: [] };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] })[]) {
        if (e.hadRecentInput) continue;
        window.__cls!.total += e.value;
        window.__cls!.shifts.push({ value: e.value, sources: (e.sources ?? []).map((s) => (s.node instanceof Element ? `${s.node.tagName.toLowerCase()}${s.node.getAttribute("data-widget") ? `[data-widget=${s.node.getAttribute("data-widget")}]` : ""}${s.node.getAttribute("data-testid") ? `[data-testid=${s.node.getAttribute("data-testid")}]` : ""}` : String(s.node?.nodeName))) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(`/t/${slug}`);
  await expect(page.getByTestId("dashboard-grid")).toBeVisible();
  // every widget streamed and the 30-day chart drawn
  await expect(page.getByTestId("widget-loading")).toHaveCount(0, { timeout: 30_000 });
  const sales = page.locator('[data-widget="sales_30d"]');
  if (await sales.count()) await expect(sales.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => window.__cls!);
}

test.describe("dashboard layout stability", () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 393, height: 852 }]) {
    test(`the home does not shift while widgets stream in (${viewport.width}×${viewport.height})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await login(page, "owner@northwind.demo");
      const cls = await measureHome(page, "northwind-apparel");
      console.log(`[cls] ${viewport.width}x${viewport.height}: ${cls.total.toFixed(4)}`, JSON.stringify(cls.shifts));
      expect(cls.total).toBeLessThan(0.02);
    });
  }
});
