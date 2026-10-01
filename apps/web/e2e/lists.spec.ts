import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";
const firstNames = async (page: import("@playwright/test").Page, n = 5) => (await page.locator("table tbody tr").evaluateAll((rows, k) => rows.slice(0, k).map((r) => r.querySelector("a")?.textContent?.trim() ?? ""), n));

test.describe("lists: search, saved views, bulk actions, CSV", () => {
  test("⌘K finds an order by number and by phone in local format and jumps to it", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/orders?status=delivered`);
    const link = page.locator("table tbody tr").first().getByRole("link").first();
    const name = (await link.textContent())!.trim();
    await page.keyboard.press("Control+k");
    await page.getByTestId("command-search-input").fill(name);
    await expect(page.getByTestId("command-search-hit").first()).toContainText(name);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    // the phone shown on the order, typed without the country prefix, finds the same order
    const phone = (await page.locator("body").innerText()).match(/\+39\s?(\d[\d ]{7,13}\d)/)?.[1];
    if (phone) {
      await page.getByTestId("command-search-trigger").click();
      await page.getByTestId("command-search-input").fill(phone.replace(/\s/g, ""));
      await expect(page.getByTestId("command-search-hit").filter({ hasText: name }).first()).toBeVisible();
    }
  });

  test("a saved view reopens with identical results, and is visible to the team when shared", async ({ page, browser }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/orders?status=delivered&payment=card&sort=total_desc`);
    const before = await firstNames(page);
    await page.getByTestId("views-menu").click();
    await page.getByTestId("save-view").click();
    const name = `E2E view ${Date.now()}`;
    await page.getByLabel(/^Name$|^Nome$/).fill(name);
    // the dialog starts from the view these filters already match (earlier runs may have saved one): make sure it is shared
    if ((await page.getByTestId("view-shared").getAttribute("aria-checked")) !== "true") await page.getByTestId("view-shared").click();
    await expect(page.getByTestId("view-shared")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("save-view-confirm").click();
    await expect(page.getByTestId("views-menu")).toContainText(name);
    await page.goto(`${T}/orders`);
    await page.getByTestId("views-menu").click();
    await page.getByTestId("view-item").filter({ hasText: name }).click();
    await expect(page).toHaveURL(/payment=card/);
    await expect(page).toHaveURL(/status=delivered/);
    await expect.poll(() => firstNames(page)).toEqual(before);
    // a teammate sees the shared view (own browser context: no session left over)
    const other = await (await browser.newContext()).newPage();
    await login(other, "care@northwind.demo");
    await other.goto(`${T}/orders`);
    await other.getByTestId("views-menu").click();
    await expect(other.getByTestId("view-item").filter({ hasText: name })).toBeVisible();
    await other.context().close();
  });

  test("bulk tags two orders and shows the summary", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/orders?status=confirmed`);
    const names = await firstNames(page, 2);
    await page.getByTestId("select-row").nth(0).click();
    await page.getByTestId("select-row").nth(1).click();
    await expect(page.getByTestId("bulk-count")).toContainText("2");
    await page.getByTestId("bulk-tag").click();
    const tag = `e2e-${Date.now()}`;
    await page.getByLabel(/Tags to add|Tag da aggiungere/).fill(tag);
    await page.getByTestId("bulk-confirm").click();
    await expect(page.getByTestId("bulk-summary")).toContainText(/Done 2|Fatti 2/);
    await page.getByRole("button", { name: /^Close$|^Chiudi$/ }).first().click();
    await page.goto(`${T}/orders?tag=${tag}`);
    await expect(page.locator("table tbody tr")).toHaveCount(2);
    expect((await firstNames(page, 2)).sort()).toEqual(names.sort());
  });

  test("CSV export: small lists download at once, large ones run in the background", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/orders?status=on_hold`);
    const href = await page.getByTestId("export-csv").getAttribute("href");
    expect(href).toContain("/orders/export?status=on_hold");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const body = await res.text();
    expect(body.split("\n")[0]).toContain("order,placed_at,status");
    expect(body.trim().split("\n").length - 1).toBe(Number(res.headers()["x-export-rows"]));
    // the whole order list is above the direct limit: queued, then ready on the exports page
    await page.goto(`${T}/orders`);
    await page.getByTestId("export-csv").click();
    await expect(page).toHaveURL(/\/exports\?queued=/);
    await expect(page.getByTestId("export-queued")).toBeVisible();
    await expect(page.getByTestId("export-row").first()).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    const file = await page.request.get((await page.getByTestId("export-download").first().getAttribute("href"))!);
    expect(file.status()).toBe(200);
    expect((await file.text()).trim().split("\n").length).toBeGreaterThan(5000);
  });

  test("product page drills down to its orders", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/products`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await page.getByTestId("product-orders-link").click();
    await expect(page).toHaveURL(/orders\?product=/);
    await expect(page.getByTestId("filter-product")).toBeVisible();
  });

  test("viewer has no selection, no bulk actions and no export", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto(`${T}/orders`);
    await expect(page.getByTestId("views-menu")).toBeVisible();
    await expect(page.getByTestId("select-row")).toHaveCount(0);
    await expect(page.getByTestId("export-csv")).toHaveCount(0);
    expect((await page.request.get(`${T}/orders/export`)).status()).toBe(403);
  });
});
