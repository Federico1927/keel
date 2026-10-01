/**
 * Captures the product screens used by the landing from a running Keel app loaded with the demo
 * seed, as the Harbor Home owner (a tenant without add-ons, so no add-on entry appears in the
 * navigation). Viewport-only captures at 2x, written as PNG to a staging directory; run
 * `pnpm --filter @keel/landing images` afterwards to produce the WebP files the landing uses.
 *
 * Usage (production build of @keel/web listening on :3000, demo seed loaded):
 *   pnpm --filter @keel/landing capture:product
 *   LOCALES=en,it ONLY=dashboard,orders pnpm --filter @keel/landing capture:product
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const OUT = resolve(process.env.CAPTURE_DIR ?? "./screenshots-src");
const LOCALES = (process.env.LOCALES ?? "en,it").split(",");
const PASSWORD = process.env.DEMO_PASSWORD ?? "keel-demo-2026";
const TENANT = process.env.DEMO_TENANT ?? "harbor-home";
const EMAIL = process.env.DEMO_EMAIL ?? "owner@harborhome.demo";
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const ONLY = new Set((process.env.ONLY ?? "").split(",").filter(Boolean));
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * `list` + `match` pages open the first detail link found on the list page. `viewport` overrides the
 * default 1440x900 for pages whose tables need more room (same 16:10 ratio).
 */
export const PAGES = [
  { name: "dashboard", path: "" },
  { name: "orders", path: "/orders" },
  { name: "order-detail", list: "/orders?status=shipped", match: "/orders/" },
  { name: "shipments", path: "/shipments" },
  { name: "products", path: "/products" },
  { name: "inventory", path: "/inventory" },
  { name: "purchasing", path: "/purchasing" },
  { name: "analytics", path: "/analytics" },
  { name: "analytics-pl", path: "/analytics?tab=pnl" },
  { name: "campaigns", path: "/campaigns", viewport: { width: 1720, height: 1075 } },
  { name: "campaign-detail", list: "/campaigns", match: "/campaigns/" },
  { name: "customers", path: "/customers" },
  { name: "rfm", path: "/customers/rfm" },
  { name: "segment-builder", path: "/segments/new" },
  { name: "returns", path: "/returns" },
  { name: "returns-analytics", path: "/returns/analytics" },
  { name: "discounts", path: "/discounts" },
  { name: "integrations", path: "/integrations" },
  { name: "integrations-guide-shopify", path: "/integrations/guide/shopify" },
];

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
  await page.waitForURL(/\/t\//);
}

async function shoot(page, dir, spec) {
  if (ONLY.size && !ONLY.has(spec.name)) return;
  const base = `${BASE}/t/${TENANT}`;
  if (spec.list) {
    await page.goto(`${base}${spec.list}`);
    const re = new RegExp(`${spec.match}${UUID}(\\?.*)?$`);
    const hrefs = await page
      .locator("main a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    const href = hrefs.find((h) => h && re.test(h));
    if (!href) {
      console.warn(`[capture] no link matching ${spec.match} on ${spec.list}, skipped`);
      return;
    }
    await page.goto(`${BASE}${href}`);
  } else {
    await page.goto(`${base}${spec.path}`);
  }
  await page.waitForLoadState("networkidle");
  await page.setViewportSize(spec.viewport ?? DEFAULT_VIEWPORT);
  // Charts animate in; give them a moment to settle.
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/${spec.name}.png`, fullPage: false });
  console.info(`[capture] ${dir}/${spec.name}.png`);
}

async function main() {
  const browser = await chromium.launch(
    existsSync(chromiumPath) ? { executablePath: chromiumPath } : {},
  );
  for (const locale of LOCALES) {
    const dir = `${OUT}/${locale}`;
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, deviceScaleFactor: 2 });
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
    const page = await context.newPage();
    await login(page);
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
    for (const spec of PAGES) await shoot(page, dir, spec);
    await context.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
