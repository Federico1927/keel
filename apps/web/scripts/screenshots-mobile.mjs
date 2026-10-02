/**
 * Phone screenshots of the Tier 1 pages (#49) into docs/screenshots/mobile/<locale>/<name>.png, at
 * the iPhone 15 viewport (393×852) with touch, as the operations user (marketing for campaigns).
 *
 * Usage (production server with the demo seed loaded):
 *   E2E_BASE_URL=http://localhost:3000 node scripts/screenshots-mobile.mjs        # en + it
 *   LOCALES=en,it,es THEME=dark node scripts/screenshots-mobile.mjs
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
];

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
    for (const user of ["ops", "marketing"]) {
      const context = await browser.newContext({ ...iphone, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: THEME });
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
      const page = await context.newPage();
      await page.goto(`${BASE}/login`);
      await page.getByLabel("Email").fill(`${user}@northwind.demo`);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
      await page.waitForURL(/\/t\//);
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
      for (const spec of PAGES.filter((p) => p.user === user)) {
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
