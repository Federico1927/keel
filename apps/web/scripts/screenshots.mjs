/**
 * Captures the main pages of the demo in every requested locale, as a tenant owner and as the
 * super-admin, into docs/screenshots/<locale>/<name>.png.
 *
 * Usage (production server on :3000 with the demo seed loaded):
 *   pnpm --filter @keel/web screenshots            # en + it
 *   LOCALES=en,it,es pnpm --filter @keel/web screenshots
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OUT = resolve(process.env.SCREENSHOT_DIR ?? "../../docs/screenshots");
const LOCALES = (process.env.LOCALES ?? "en,it").split(",");
const PASSWORD = process.env.DEMO_PASSWORD ?? "keel-demo-2026";
const TENANT = "northwind-apparel";
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
/** Comma-separated page names to (re)capture; empty means all. */
/** Full-page captures are clipped at this height so a long ledger does not produce a 25k-pixel image. */
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT ?? 3200);
const ONLY = new Set((process.env.ONLY ?? "").split(",").filter(Boolean));

/** Static pages first; `detail` pages resolve their id from the first matching link in a list. */
const TENANT_PAGES = [
  { name: "dashboard", path: "" },
  { name: "orders", path: "/orders" },
  { name: "order-detail", list: "/orders?status=shipped", match: "/orders/" },
  { name: "shipments", path: "/shipments" },
  { name: "products", path: "/products" },
  { name: "product-detail", list: "/products", match: "/products/" },
  { name: "inventory", path: "/inventory" },
  { name: "purchasing", path: "/purchasing" },
  { name: "purchase-order-detail", list: "/purchasing", match: "/purchasing/" },
  { name: "suppliers", path: "/purchasing/suppliers" },
  { name: "analytics", path: "/analytics" },
  { name: "analytics-pl", path: "/analytics?tab=pnl" },
  { name: "campaigns", path: "/campaigns" },
  { name: "campaign-detail", list: "/campaigns", match: "/campaigns/" },
  { name: "campaigns-ledger", path: "/campaigns/ledger" },
  { name: "customers", path: "/customers" },
  { name: "customer-detail", list: "/customers", match: "/customers/" },
  { name: "rfm", path: "/customers/rfm" },
  { name: "segments", path: "/segments" },
  { name: "segment-builder", path: "/segments/new" },
  { name: "returns", path: "/returns" },
  { name: "return-detail", list: "/returns", match: "/returns/" },
  { name: "returns-analytics", path: "/returns/analytics" },
  { name: "return-reasons", path: "/returns/reasons" },
  { name: "discounts", path: "/discounts" },
  { name: "discount-detail", list: "/discounts", match: "/discounts/" },
  { name: "integrations", path: "/integrations" },
  { name: "integrations-guide-shopify", path: "/integrations/guide/shopify" },
  { name: "settings", path: "/settings" },
  { name: "order-state-rules", path: "/settings/order-states" },
  { name: "users", path: "/users" },
  { name: "audit", path: "/audit" },
  { name: "cod-queue", path: "/cod" },
  { name: "cod-settings", path: "/cod/settings" },
];
const ADMIN_PAGES = [
  { name: "admin-dashboard", path: "/admin" },
  { name: "admin-tenants", path: "/admin/tenants" },
  { name: "admin-tenant-detail", list: "/admin/tenants", match: "/admin/tenants/" },
  { name: "admin-tenant-new", path: "/admin/tenants/new" },
  { name: "admin-billing", path: "/admin/billing" },
  { name: "admin-audit", path: "/admin/audit" },
];

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
  await page.waitForURL(/\/t\/|\/admin/);
}

async function setLocale(context, locale) {
  await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
}

/** Full page up to MAX_HEIGHT. */
async function capture(page, path) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewport = page.viewportSize();
  await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: Math.min(height, MAX_HEIGHT) } });
}

async function shoot(page, dir, spec, base) {
  if (ONLY.size && !ONLY.has(spec.name)) return;
  const path = spec.path;
  if (spec.list) {
    await page.goto(`${BASE}${base}${spec.list}`);
    // Detail routes end with a UUID; this skips sibling pages such as /campaigns/ledger or /returns/new.
    const re = new RegExp(`${spec.match}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\?.*)?$`);
    const href = (await page.locator("main a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")))).find((h) => h && re.test(h));
    if (!href) {
      console.warn(`[screenshots] no link matching ${spec.match} on ${spec.list}, skipped`);
      return;
    }
    await page.goto(`${BASE}${href}`);
  } else {
    await page.goto(`${BASE}${base}${path}`);
  }
  await page.waitForLoadState("networkidle");
  await capture(page, `${dir}/${spec.name}.png`);
  console.info(`[screenshots] ${dir}/${spec.name}.png`);
}

async function main() {
  const browser = await chromium.launch(existsSync(chromiumPath) ? { executablePath: chromiumPath } : {});
  for (const locale of LOCALES) {
    const dir = `${OUT}/${locale}`;
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await setLocale(context, locale);
    await page.goto(`${BASE}/login`);
    if (!ONLY.size || ONLY.has("login")) await capture(page, `${dir}/login.png`);
    await login(page, "owner@northwind.demo");
    await setLocale(context, locale);
    for (const spec of TENANT_PAGES) await shoot(page, dir, spec, `/t/${TENANT}`);
    await context.close();

    const admin = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const apage = await admin.newPage();
    await setLocale(admin, locale);
    await login(apage, "superadmin@keel.demo");
    await setLocale(admin, locale);
    for (const spec of ADMIN_PAGES) await shoot(apage, dir, spec, "");
    await admin.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
