/**
 * Phone screenshots of the Tier 1, 2 and 3 pages (#49) into docs/screenshots/mobile/<locale>/<name>.png,
 * at the iPhone 15 viewport (393×852) with touch, as the operations user (marketing for campaigns, the
 * owner for the Tier 2 pages: customers, purchasing, discounts, segments, settings, users, integrations…,
 * and for the Tier 3 analysis and configuration pages).
 *
 * Usage (production server with the demo seed loaded):
 *   E2E_BASE_URL=http://localhost:3000 node scripts/screenshots-mobile.mjs        # en + it
 *   LOCALES=en,it,es THEME=dark node scripts/screenshots-mobile.mjs
 *   TIER=2 node scripts/screenshots-mobile.mjs                                   # only the Tier 2 pages
 *   TIER=3 node scripts/screenshots-mobile.mjs                                   # only the Tier 3 pages
 */
import { chromium, devices } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OUT = resolve(process.env.SCREENSHOT_DIR ?? "../../docs/screenshots/mobile");
const LOCALES = (process.env.LOCALES ?? "en,it").split(",");
const THEME = process.env.THEME ?? "light";
const PASSWORD = process.env.DEMO_PASSWORD ?? "hullwise-demo-2026";
const T = "/t/northwind-apparel";
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT ?? 2600);
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 15"];

const PAGES = [
  { user: "ops", name: "dashboard", path: "" },
  { user: "ops", name: "orders", path: "/orders" },
  { user: "ops", name: "order-filters", path: "/orders", action: async (page) => page.getByTestId("filters-open").click() },
  { user: "ops", name: "order-detail", list: "/orders?status=confirmed", match: /\/orders\/[0-9a-f-]{36}$/ },
  { user: "ops", name: "shipments", path: "/shipments" },
  { user: "ops", name: "fulfilment", path: "/fulfilment" },
  { user: "ops", name: "delivery-exceptions", path: "/fulfilment/exceptions" },
  { user: "ops", name: "returns", path: "/returns" },
  { user: "ops", name: "return-detail", list: "/returns?status=approved", match: /\/returns\/[0-9a-f-]{36}$/ },
  { user: "ops", name: "products", path: "/products" },
  { user: "ops", name: "product-detail", list: "/products", match: /\/products\/[0-9a-f-]{36}$/ },
  { user: "ops", name: "inventory", path: "/inventory" },
  { user: "ops", name: "stock-takes", path: "/inventory/stock-takes" },
  { user: "ops", name: "stock-take-detail", list: "/inventory/stock-takes", match: /\/stock-takes\/[0-9a-f-]{36}$/ },
  { user: "ops", name: "notifications", path: "/notifications" },
  { user: "ops", name: "mentions", path: "/notifications/mentions" },
  { user: "ops", name: "approvals", path: "/approvals" },
  { user: "ops", name: "cod-queue", path: "/cod" },
  { user: "ops", name: "more-sheet", path: "/orders", action: async (page) => page.getByTestId("bottom-nav-more").click() },
  { user: "ops", name: "search", path: "/orders", action: async (page) => page.getByTestId("command-search-trigger").click() },
  { user: "marketing", name: "campaigns", path: "/campaigns?preset=90d" },
  // Tier 2 (wave 2)
  { user: "owner", tier: 2, name: "customers", path: "/customers?sort=total_spent" },
  { user: "owner", tier: 2, name: "customer-detail", list: "/customers?sort=total_spent", match: /\/customers\/[0-9a-f-]{36}$/ },
  { user: "owner", tier: 2, name: "purchasing", path: "/purchasing" },
  { user: "owner", tier: 2, name: "po-editor", path: "/purchasing/new" },
  { user: "owner", tier: 2, name: "suppliers", path: "/purchasing/suppliers" },
  { user: "owner", tier: 2, name: "discounts", path: "/discounts" },
  { user: "owner", tier: 2, name: "discount-pool", list: "/discounts", match: /\/discounts\/pools\/[0-9a-f-]{36}$/ },
  { user: "owner", tier: 2, name: "segments", path: "/segments" },
  { user: "owner", tier: 2, name: "segment-builder", path: "/segments/new" },
  { user: "owner", tier: 2, name: "customer-campaigns", path: "/segments/campaigns" },
  { user: "owner", tier: 2, name: "settings", path: "/settings" },
  { user: "owner", tier: 2, name: "users", path: "/users" },
  { user: "owner", tier: 2, name: "integrations", path: "/integrations" },
  { user: "owner", tier: 2, name: "integration-guide", path: "/integrations/guide/shopify" },
  { user: "owner", tier: 2, name: "campaign-detail", list: "/campaigns?preset=90d", match: /\/campaigns\/[0-9a-f-]{36}(\?|$)/ },
  { user: "owner", tier: 2, name: "profile", path: "/profile" },
  // Tier 3 (wave 3): readable analysis and configuration, wide tables scroll inside their region
  { user: "owner", tier: 3, name: "analytics", path: "/analytics?preset=90d" },
  { user: "owner", tier: 3, name: "analytics-pnl", path: "/analytics?tab=pnl&preset=90d&gran=week" },
  { user: "owner", tier: 3, name: "analytics-chart-fullscreen", path: "/analytics?tab=pnl&preset=90d", action: async (page) => page.getByTestId("chart-fullscreen").first().click() },
  { user: "owner", tier: 3, name: "analytics-orders-pnl", path: "/analytics?tab=orders_pnl&preset=30d" },
  { user: "owner", tier: 3, name: "analytics-products", path: "/analytics?tab=products&preset=30d" },
  { user: "owner", tier: 3, name: "analytics-cohorts", path: "/analytics?tab=cohorts" },
  { user: "owner", tier: 3, name: "payouts", path: "/analytics/payouts" },
  { user: "owner", tier: 3, name: "returns-analytics", path: "/returns/analytics" },
  { user: "owner", tier: 3, name: "planning", path: "/inventory/planning" },
  { user: "owner", tier: 3, name: "planning-forecast", path: "/inventory/planning?tab=forecast" },
  { user: "owner", tier: 3, name: "markdowns", path: "/inventory/markdowns" },
  { user: "owner", tier: 3, name: "losses", path: "/inventory/losses?preset=90d" },
  { user: "owner", tier: 3, name: "catalog-quality", path: "/products/quality" },
  { user: "owner", tier: 3, name: "campaign-ledger", path: "/campaigns/ledger?preset=7d" },
  { user: "owner", tier: 3, name: "campaign-words", path: "/campaigns/words" },
  { user: "owner", tier: 3, name: "cod-settings", path: "/cod/settings" },
  { user: "owner", tier: 3, name: "cod-team", path: "/cod/team?tab=efficiency" },
  { user: "owner", tier: 3, name: "suppressions", path: "/notifications/suppressions" },
  { user: "owner", tier: 3, name: "audit", path: "/audit" },
  { user: "owner", tier: 3, name: "state-rules", path: "/settings/order-states" },
];
const TIER = process.env.TIER ? Number(process.env.TIER) : null;
const SELECTED = PAGES.filter((p) => TIER === null || (p.tier ?? 1) === TIER);

/** The whole page up to MAX_HEIGHT; the viewport grows to it so the bottom bar sits at the bottom, as on the phone. */
async function capture(page, path) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 393, height: Math.max(852, Math.min(height, MAX_HEIGHT)) });
  await page.waitForTimeout(300);
  await page.screenshot({ path });
  await page.setViewportSize({ width: 393, height: 852 });
}

async function main() {
  const browser = await chromium.launch(existsSync(chromiumPath) ? { executablePath: chromiumPath } : {});
  for (const locale of LOCALES) {
    const dir = THEME === "light" ? `${OUT}/${locale}` : `${OUT}/${locale}/${THEME}`;
    mkdirSync(dir, { recursive: true });
    for (const user of [...new Set(SELECTED.map((p) => p.user))]) {
      const context = await browser.newContext({ ...iphone, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: THEME });
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
      const page = await context.newPage();
      await page.goto(`${BASE}/login`);
      await page.getByLabel("Email").fill(`${user}@northwind.demo`);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
      await page.waitForURL(/\/t\//);
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
      for (const spec of SELECTED.filter((p) => p.user === user)) {
        if (spec.list) {
          await page.goto(`${BASE}${T}${spec.list}`);
          const href = (await page.locator("main a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")))).find((h) => h && spec.match.test(h));
          if (!href) { console.warn(`[mobile screenshots] nothing for ${spec.name}`); continue; }
          await page.goto(`${BASE}${href}`);
        } else await page.goto(`${BASE}${T}${spec.path}`);
        await page.waitForLoadState("networkidle");
        if (spec.action) {
          await spec.action(page);
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${dir}/${spec.name}.png` });
        } else await capture(page, `${dir}/${spec.name}.png`);
        console.info(`[mobile screenshots] ${dir}/${spec.name}.png`);
      }
      await context.close();
    }
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
