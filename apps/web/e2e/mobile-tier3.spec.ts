import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tier 3 on a phone (#49, wave 3): analysis and configuration pages are readable (no sideways page
 * scroll, wide tables scroll inside a marked region, complex editors carry a "better on a larger
 * screen" notice) and one representative action per area works. Runs in the mobile-* projects with
 * one worker; what it writes is put back (a cost restored, a suppression removed, COD settings saved
 * unchanged) except the markdown it applies, as the desktop spec does.
 */
test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";

async function noSideScroll(page: Page, label: string, soft = false) {
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  (soft ? expect.soft : expect)(m.scroll, `${label} scrolls sideways (${m.scroll} > ${m.client})`).toBeLessThanOrEqual(m.client);
}

async function firstRecordHref(page: Page, path: RegExp): Promise<string | null> {
  const hrefs = await page.locator("main a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  return hrefs.find((h) => path.test(h.split("?")[0]!)) ?? null;
}

async function productHref(page: Page): Promise<string> {
  await page.goto(`${NW}/products`);
  const href = await firstRecordHref(page, /\/products\/[0-9a-f-]{36}$/);
  expect(href, "a product to open").toBeTruthy();
  return href!.split("?")[0]!;
}

async function editorHref(page: Page): Promise<string | null> {
  await page.goto(NW);
  const home = await page.getByTestId("edit-home").getAttribute("href").catch(() => null);
  if (home) return home;
  await page.goto(`${NW}/dashboards`);
  const dash = await firstRecordHref(page, /\/dashboards\/[0-9a-f-]{36}$/);
  return dash ? `${dash.split("?")[0]}/edit` : null;
}

test("every Tier 3 page fits the phone screen", async ({ page }) => {
  test.setTimeout(480_000);
  await login(page, "owner@northwind.demo");
  const analyticsTabs = ["overview", "custom", "pnl", "orders_pnl", "payments", "tax", "attribution", "utm", "products", "cohorts", "ltv", "basket", "survey"];
  const planningTabs = ["replenishment", "forecast", "analysis", "transfers", "cashflow", "target", "bundles"];
  const pages = [
    ...analyticsTabs.map((t) => `/analytics?tab=${t}&preset=90d`),
    "/analytics?tab=pnl&preset=90d&gran=week", "/analytics?tab=attribution&preset=90d&by=campaign", "/analytics?tab=ltv&by=channel",
    "/analytics/payouts", "/analytics/alerts",
    "/returns/analytics",
    ...planningTabs.map((t) => `/inventory/planning?tab=${t}`), "/inventory/planning?tab=target&target=50000&months=3",
    "/inventory/markdowns", "/inventory/losses?preset=90d",
    "/products/import-costs", "/products/quality", "/products/quality?issue=missing_barcode",
    "/campaigns/ledger?preset=30d", "/campaigns/recommendations", "/campaigns/words",
    "/cod/settings", "/cod/team?tab=supervisor", "/cod/team?tab=efficiency", "/cod/team?tab=attribution",
    "/notifications/suppressions", "/audit",
    "/settings/order-states",
  ];
  // every page is checked before the test fails, so one run lists every offender
  for (const p of pages) {
    await page.goto(`${NW}${p}`);
    await noSideScroll(page, p, true);
  }
  // the product page (costs, suppliers and packs) and its option mix
  const product = await productHref(page);
  await page.goto(product);
  await noSideScroll(page, product);
  const mix = `${product.replace("/products/", "/purchasing/mix/")}`;
  await page.goto(mix);
  await noSideScroll(page, mix);
  // the dashboard layout editor
  const editor = await editorHref(page);
  if (editor) {
    await page.goto(editor);
    await expect(page.getByTestId("dashboard-editor")).toBeVisible();
    await noSideScroll(page, editor);
  }
});

test("wide analysis tables scroll inside their marked region, the page never does", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  for (const p of ["/analytics?tab=pnl&preset=90d&gran=week", "/analytics?tab=products&preset=30d", "/analytics?tab=cohorts"]) {
    await page.goto(`${NW}${p}`);
    const region = page.getByRole("region").filter({ has: page.locator("table") }).last();
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("tabindex", "0");
    expect(await region.getAttribute("aria-label")).toBeTruthy();
    const m = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).overflowX }));
    expect(m.overflow).toBe("auto");
    expect(m.scroll, `${p}: the table is wider than the phone`).toBeGreaterThan(m.client);
    // the hint says so, and the first column stays put while the rest scrolls
    const wrapper = region.locator("xpath=ancestor::*[@data-scroll-table][1]");
    await expect(wrapper).toHaveAttribute("data-overflowing", "true");
    await expect(wrapper.getByTestId("scroll-hint")).toBeVisible();
    const firstCell = region.locator("tbody tr").first().locator("td").first();
    const before = await firstCell.boundingBox();
    await region.evaluate((el) => el.scrollBy({ left: 200 }));
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    const after = await firstCell.boundingBox();
    expect(Math.round(after!.x)).toBe(Math.round(before!.x));
    await noSideScroll(page, p);
  }
  // lists stay lists: cards with labelled facts, no table header
  await page.goto(`${NW}/analytics?tab=orders_pnl&preset=30d`);
  const row = page.getByTestId("order-pnl-row").first();
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  await expect(row.locator("td[data-label]").first()).toBeVisible();
});

test("complex editors say they are better on a larger screen; charts open full screen", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/settings/order-states`);
  await expect(page.getByTestId("desktop-notice")).toBeVisible();
  // the simple actions stay possible: the rule form opens as a sheet
  await page.getByRole("button", { name: /Add rule|Aggiungi regola/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: /^Cancel$|^Annulla$/ }).click();
  await page.goto(`${NW}/inventory/planning?tab=forecast`);
  await expect(page.getByTestId("desktop-notice")).toBeVisible();
  await expect(page.getByTestId("forecast-grid")).toBeVisible();
  const editor = await editorHref(page);
  if (editor) {
    await page.goto(editor);
    await expect(page.getByTestId("desktop-notice")).toBeVisible();
  }
  // a chart opens in a full-screen sheet and fills it
  await page.goto(`${NW}/analytics?tab=pnl&preset=90d`);
  await page.getByTestId("chart-fullscreen").first().click();
  const sheet = page.getByTestId("chart-fullscreen-sheet");
  await expect(sheet).toBeVisible();
  const chart = sheet.getByTestId("pnl-chart");
  await expect(chart).toBeVisible();
  expect((await chart.boundingBox())!.height).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("products: save a variant cost from the phone (and put it back)", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(await productHref(page));
  const card = page.getByTestId("variant-costs");
  const input = card.getByTestId("cost-input").first();
  await expect(input).toBeVisible();
  const before = await input.inputValue();
  const next = before === "12.34" ? "12.35" : "12.34";
  await input.fill(next);
  await card.getByTestId("cost-save").click();
  await expect(card.getByTestId("cost-result")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("variant-costs").getByTestId("cost-input").first()).toHaveValue(next);
  // restore
  await page.getByTestId("variant-costs").getByTestId("cost-input").first().fill(before);
  await page.getByTestId("variant-costs").getByTestId("cost-save").click();
  await expect(page.getByTestId("variant-costs").getByTestId("cost-result")).toBeVisible();
  await noSideScroll(page, "product costs");
});

test("inventory: apply a markdown suggestion after confirming in a sheet", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/inventory/markdowns`);
  const rows = page.getByTestId("markdown-row");
  await expect(rows.first()).toBeVisible();
  await rows.first().getByTestId("markdown-select").click();
  await page.getByTestId("apply-markdowns").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // a bottom sheet on the phone: docked to the bottom of the screen, full width
  const box = (await dialog.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(vp.height - 2);
  await dialog.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("markdown-summary")).toContainText(/^1 /, { timeout: 30_000 });
});

test("COD add-on: save the queue settings from the phone", async ({ page }) => {
  await login(page, "admin@northwind.demo");
  await page.goto(`${NW}/cod/settings`);
  await expect(page.getByTestId("capacity-row").first()).toBeVisible();
  const ops = page.getByTestId("ops-settings");
  const field = ops.getByLabel(/Transfers per operator per day|Trasferimenti per operatore al giorno/);
  const value = await field.inputValue();
  await field.fill(value);
  await ops.getByTestId("save-ops").click();
  await expect(ops.getByText(/Saved\.|Salvato\./)).toBeVisible();
  await noSideScroll(page, "cod settings");
});

test("notifications: add a suppression from the phone and remove it", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/notifications/suppressions`);
  const email = `mobile-suppression-${Date.now()}@e2e.test`;
  await page.locator("#sup-email").fill(email);
  await page.getByRole("button", { name: /^Suppress address$|^Blocca indirizzo$/ }).click();
  const row = page.getByTestId("suppression-row").filter({ hasText: email });
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  await row.getByRole("button", { name: /Remove|Rimuovi/ }).click();
  await expect(row).toHaveCount(0);
  await noSideScroll(page, "suppressions");
});
