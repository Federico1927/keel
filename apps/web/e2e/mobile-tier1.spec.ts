import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tier 1 on a phone (#49): every page fits the screen (no sideways scroll), and the operational
 * flows work one-handed: list → detail → action → confirmation. Runs in the mobile-* projects
 * (iPhone 15 and Pixel 7, light and dark) with one worker, since it writes demo data.
 */
test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";
const HH = "/t/harbor-home";
const SCAN_EVENT = "app:scan";

async function noSideScroll(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(m.scroll, `${label} scrolls sideways (${m.scroll} > ${m.client})`).toBeLessThanOrEqual(m.client);
}

/** The first link of a list whose href is a record page under `path`. */
async function firstRecordHref(page: Page, path: RegExp): Promise<string> {
  const hrefs = await page.locator("main a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  const href = hrefs.find((h) => path.test(h));
  if (!href) throw new Error(`no link matching ${path}`);
  return href;
}

async function simulateScan(page: Page, code: string) {
  await page.evaluate(([name, detail]) => window.dispatchEvent(new CustomEvent(name!, { detail })), [SCAN_EVENT, code]);
}

test("every Tier 1 page fits the phone screen", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "owner@northwind.demo");
  const pages = ["", "/orders", "/shipments", "/fulfilment", "/fulfilment/exceptions", "/returns", "/products", "/inventory", "/inventory/stock-takes", "/notifications", "/notifications/mentions", "/approvals", "/cod", "/campaigns", "/settings/mobile"];
  for (const p of pages) {
    await page.goto(`${NW}${p}`);
    await noSideScroll(page, p || "/");
  }
  // detail pages, reached from their lists
  for (const [list, re] of [["/orders?status=confirmed", /\/orders\/[0-9a-f-]{36}$/], ["/returns", /\/returns\/[0-9a-f-]{36}$/], ["/products", /\/products\/[0-9a-f-]{36}$/], ["/inventory/stock-takes", /\/stock-takes\/[0-9a-f-]{36}$/], ["/campaigns?preset=90d", /\/campaigns\/[0-9a-f-]{36}/]] as const) {
    await page.goto(`${NW}${list}`);
    const href = await firstRecordHref(page, re).catch(() => null);
    if (!href) continue;
    await page.goto(href);
    await noSideScroll(page, href);
  }
  await page.goto("/offline");
  await noSideScroll(page, "/offline");
});

test("shell: bottom navigation with the role's destinations, More sheet, full-screen search, 44px targets", async ({ page }) => {
  await login(page, "ops@northwind.demo");
  const nav = page.getByTestId("bottom-nav");
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(4);
  for (const box of await nav.locator("a, button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  await nav.getByTestId("bottom-nav-orders").click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(nav.getByTestId("bottom-nav-orders")).toHaveAttribute("aria-current", "page");
  await nav.getByTestId("bottom-nav-more").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: /Inventory|Magazzino/ }).first()).toBeVisible();
  await sheet.getByRole("link", { name: /Inventory|Magazzino/ }).first().click();
  await expect(page).toHaveURL(/\/inventory$/);
  // search opens full screen
  await page.getByTestId("command-search-trigger").click();
  const search = page.getByRole("dialog");
  const box = await search.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual((page.viewportSize()!.width) - 1);
  await page.keyboard.press("Escape");
});

test("operations finds an order by phone, changes its status, adds a note and edits the address", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "ops@harborhome.demo");
  // an editable prepaid order and the phone its customer calls from
  await page.goto(`${HH}/orders?status=confirmed&payment=card&paymentStatus=paid`);
  const hrefs = (await page.locator("[data-testid=order-row] a").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))).filter((h) => /\/orders\/[0-9a-f-]{36}$/.test(h));
  let name = "";
  let phone = "";
  for (const href of hrefs) {
    await page.goto(href);
    if ((await page.getByTestId("edit-order").count()) === 0 || (await page.getByTestId("order-phone").count()) === 0) continue;
    name = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
    phone = ((await page.getByTestId("order-phone").getAttribute("href")) ?? "").replace(/^tel:/, "");
    break;
  }
  expect(name).not.toBe("");
  // search the list with the local number, as the customer would dictate it
  await page.goto(`${HH}/orders`);
  const local = phone.replace(/^\+1/, "");
  await page.getByRole("searchbox").fill(`${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`);
  await page.getByRole("button", { name: /^Search$|^Cerca$/ }).click();
  await expect(page).toHaveURL(/q=/);
  const row = page.getByTestId("order-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await noSideScroll(page, "orders search");
  // the whole card opens the order
  await row.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

  // status from the docked action bar, confirmed in a bottom sheet
  const bar = page.locator("[data-sticky-actions]");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: /Change status|Cambia stato/ }).click();
  await page.getByRole("menuitem", { name: /^On hold$|^In attesa$/ }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel(/Note \(optional\)|Nota \(facoltativa\)/).fill("mobile: customer asked to wait");
  await sheet.getByRole("button", { name: /^Confirm$|^Conferma$/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Status changed|Stato cambiato/).first()).toBeVisible();

  // note: the bar's shortcut jumps to the composer
  await bar.getByTestId("sticky-add-note").click();
  const note = `Called from the phone ${Date.now()}`;
  await page.getByPlaceholder(/Write a note|Scrivi una nota/).fill(note);
  await page.getByRole("button", { name: /Add note|Aggiungi nota/ }).click();
  await expect(page.locator("li", { hasText: note }).first()).toBeVisible();

  // address in the edit sheet
  await page.getByTestId("edit-order").click();
  const edit = page.getByRole("dialog");
  const apt = `Apt ${Date.now() % 1000}`;
  await edit.getByLabel(/^Address line 2$|^Indirizzo \(riga 2\)$/).fill(apt);
  await edit.getByTestId("edit-save").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(apt).first()).toBeVisible();

  // back to the rules so the order keeps flowing for other runs
  await bar.getByRole("button", { name: /Change status|Cambia stato/ }).click();
  await page.getByRole("menuitem", { name: /Let rules decide|Lascia decidere/ }).click();
  await noSideScroll(page, "order detail");
});

test("the full-screen search finds an order by phone number", async ({ page }) => {
  await login(page, "ops@harborhome.demo");
  await page.goto(`${HH}/orders?status=delivered`);
  await page.locator("[data-testid=order-row] a").first().click();
  const tel = await page.getByTestId("order-phone").getAttribute("href");
  const name = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
  await page.getByTestId("command-search-trigger").click();
  await page.getByTestId("command-search-input").fill(tel!.replace(/^tel:\+1/, ""));
  const hit = page.getByTestId("command-search-hit").filter({ hasText: name });
  await expect(hit.first()).toBeVisible();
  await hit.first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
});

test("operations receives a return by scanning and puts it back in stock", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "ops@harborhome.demo");
  const rows = page.getByTestId("return-row");
  const returnHrefs = async (status: string) => {
    await page.goto(`${HH}/returns?status=${status}`);
    await page.waitForLoadState("networkidle");
    return (await rows.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))).filter((h) => /\/returns\/[0-9a-f-]{36}$/.test(h));
  };
  // approved returns get used up by earlier runs: approve a requested one from its sheet first
  let hrefs = await returnHrefs("approved");
  if (hrefs.length === 0) {
    const requested = await returnHrefs("requested");
    expect(requested.length).toBeGreaterThan(0);
    await page.goto(requested[0]!);
    await page.locator("[data-sticky-actions]").getByRole("button", { name: /^Approve$|^Approva$/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Approve$|^Approva$/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    hrefs = [requested[0]!];
  }
  let sku = "";
  for (const href of hrefs) {
    await page.goto(href);
    const bar = page.locator("[data-sticky-actions]");
    if ((await bar.getByRole("button", { name: /Mark received|Segna ricevuto/ }).count()) === 0) continue;
    await bar.getByRole("button", { name: /Mark received|Segna ricevuto/ }).click();
    const sheet = page.getByRole("dialog");
    const lines = sheet.getByTestId("restock-line");
    if ((await lines.count()) === 0 || (await lines.first().isDisabled()) || !(await lines.first().getAttribute("data-code"))) { await page.keyboard.press("Escape"); continue; }
    // untick, then let the scanner tick it again from the item's SKU
    const label = await lines.first().getAttribute("aria-label");
    sku = (await lines.first().getAttribute("data-code"))!;
    await lines.first().uncheck();
    await sheet.getByTestId("scan-camera").click();
    await expect(page.getByTestId("scanner-view")).toBeVisible();
    await simulateScan(page, sku);
    await expect(page.getByTestId("scanner-last")).toContainText(sku);
    await page.getByRole("button", { name: /^Done$|^Fatto$/ }).first().click();
    await expect(sheet.getByTestId("return-scan-result")).toBeVisible();
    await expect(sheet.getByRole("checkbox", { name: label! })).toBeChecked();
    await sheet.getByRole("button", { name: /Mark received|Segna ricevuto/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/Received|Ricevuto/).first()).toBeVisible();
    await expect(page.getByText(/Restocked at|Rientrato a stock|Rientro/).first()).toBeVisible();
    await noSideScroll(page, "return detail");
    return;
  }
  throw new Error("no approved return with a line to restock");
});

test("operations counts a location's stock by scanning", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "ops@northwind.demo");
  // a SKU to count, from the inventory list
  await page.goto(`${NW}/inventory`);
  const meta = await page.getByTestId("inventory-row").first().locator("p").first().textContent();
  const sku = meta!.split("·").pop()!.trim();
  await page.goto(`${NW}/inventory/stock-takes`);
  await page.getByTestId("create-stock-take").click();
  await expect(page).toHaveURL(/\/stock-takes\/[0-9a-f-]{36}$/);
  await noSideScroll(page, "stock-take");
  // camera: two reads of the same code a moment apart count two units
  await page.getByTestId("scan-camera").click();
  await expect(page.getByTestId("scanner-view")).toBeVisible();
  await simulateScan(page, sku);
  await expect(page.getByTestId("scanner-last")).toContainText(sku);
  await page.getByRole("button", { name: /^Done$|^Fatto$/ }).first().click();
  await expect(page.getByTestId("scan-result")).toContainText(/: counted 1|: contat[io] 1|1/);
  // a hardware scanner types the code and Enter in the field
  await page.getByTestId("scan-code").fill(sku);
  await page.getByTestId("scan-code").press("Enter");
  await expect(page.getByTestId("scan-result")).toContainText(/2/);
  await expect(page.getByTestId("stock-take-line").first()).toBeVisible();
  // leave the demo stock as it was
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("cancel-stock-take").click();
  await expect(page.getByTestId("stock-take-status")).toHaveText(/Cancelled|Annullat/);
});

test("marketing pauses a losing campaign from the list and resumes it", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "marketing@northwind.demo");
  await page.goto(`${NW}/campaigns?preset=90d&status=active`);
  await noSideScroll(page, "campaigns");
  const row = page.getByTestId("campaign-row").filter({ has: page.getByRole("button", { name: /Pause campaign|Metti in pausa/ }) }).first();
  await expect(row).toBeVisible();
  const href = await row.getByRole("link").first().getAttribute("href");
  await row.getByRole("button", { name: /Pause campaign|Metti in pausa/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText(/Meta|TikTok/);
  await sheet.getByRole("button", { name: /^Confirm$|^Conferma$/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(href!);
  await expect(page.getByRole("button", { name: /Resume campaign|Riattiva/ })).toBeVisible();
  await page.getByRole("button", { name: /Resume campaign|Riattiva/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Confirm$|^Conferma$/ }).click();
  await expect(page.getByRole("button", { name: /Pause campaign|Metti in pausa/ })).toBeVisible();
});

test("installable: a valid manifest, and the service worker never caches tenant data", async ({ page, request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.display).toBe("standalone");
  expect(m.start_url).toBe("/");
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  for (const size of ["192x192", "512x512"]) {
    const icon = m.icons.find((i: { sizes: string }) => i.sizes === size);
    expect(icon, size).toBeTruthy();
    expect((await request.get(icon.src)).headers()["content-type"]).toContain("image/png");
  }
  expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);

  await login(page, "ops@northwind.demo");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  for (const p of ["/orders", "/returns", "/inventory"]) await page.goto(`${NW}${p}`);
  await page.waitForLoadState("networkidle");
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname + new URL(r.url).search);
    return urls;
  });
  expect(cached.some((u) => u.startsWith("/_next/static/"))).toBe(true);
  expect(cached.filter((u) => /^\/t\/|^\/api\/|^\/admin|_rsc=/.test(u))).toEqual([]);
});
