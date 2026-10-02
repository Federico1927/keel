import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

/** SKU of a well-stocked variant, read from the inventory list. */
async function stockedSku(page: Page): Promise<string> {
  await page.goto(`${T}/inventory?risk=ok`);
  const detail = await page.locator("table tbody tr").first().locator("td").first().locator("p").innerText();
  const sku = detail.split("·").pop()!.trim();
  expect(sku.length).toBeGreaterThan(0);
  return sku;
}
const availableOf = async (page: Page) => Number((await page.locator("table tbody tr").first().locator("td").nth(1).innerText()).replace(/\D/g, ""));

test.describe("inventory control", () => {
  test("stock adjustment with a reason: found units in, damaged units out, shown on the product", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    const sku = await stockedSku(page);
    await page.goto(`${T}/inventory?q=${encodeURIComponent(sku)}`);
    const before = await availableOf(page);
    // found +3
    await page.locator("table tbody tr").first().getByTestId("adjust-stock").click();
    const form = page.getByTestId("adjust-form");
    await form.getByTestId("adjust-reason").selectOption("found");
    await form.getByTestId("adjust-qty").fill("3");
    await form.getByTestId("adjust-submit").click();
    await expect(form).toBeHidden();
    await expect.poll(() => availableOf(page)).toBe(before + 3);
    // damaged −2
    await page.locator("table tbody tr").first().getByTestId("adjust-stock").click();
    await page.getByTestId("adjust-reason").selectOption("damaged");
    await page.getByTestId("adjust-qty").fill("2");
    await expect(page.getByTestId("adjust-preview")).toContainText("−2");
    await page.getByTestId("adjust-submit").click();
    await expect(page.getByTestId("adjust-form")).toBeHidden();
    await expect.poll(() => availableOf(page)).toBe(before + 1);
    // the product page lists the movement with its reason
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/Adjustment · Damaged|Rettifica · Danneggiato/).first()).toBeVisible();
  });

  test("stock-take: scan, unknown code, review and apply in one batch", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    await login(page, "ops@northwind.demo");
    const sku = await stockedSku(page);
    await page.goto(`${T}/inventory`);
    await page.getByTestId("stock-takes-link").click();
    await expect(page).toHaveURL(/\/inventory\/stock-takes$/);
    await page.getByTestId("create-stock-take").click();
    await expect(page).toHaveURL(/\/inventory\/stock-takes\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("stock-take-status")).toHaveText(/Open|Aperto/);
    // two scans of the same code (Enter), then a code the catalogue does not know
    const code = page.getByTestId("scan-code");
    await code.fill(sku);
    await code.press("Enter");
    await expect(page.getByTestId("scan-result")).toContainText(/(counted|contati) 1$/);
    await code.fill(sku.toLowerCase());
    await code.press("Enter");
    await expect(page.getByTestId("scan-result")).toContainText(/(counted|contati) 2$/);
    await code.fill("E2E-NOT-A-SKU");
    await code.press("Enter");
    await expect(page.getByTestId("scan-result")).toContainText("E2E-NOT-A-SKU");
    await expect(page.getByTestId("stock-take-line")).toHaveCount(2);
    await expect(page.locator('[data-testid="stock-take-line"][data-status="unknown"]')).toHaveCount(1);
    const counted = page.locator('[data-testid="stock-take-line"]:not([data-status="unknown"])');
    await expect(counted).toHaveAttribute("data-status", /missing|surplus|match/);
    // apply: one batch, the session closes
    await page.getByTestId("apply-stock-take").click();
    await expect(page.getByTestId("stock-take-status")).toHaveText(/Applied|Applicato/);
    await expect(page.getByTestId("scan-code")).toHaveCount(0);
    await page.goto(`${T}/inventory/stock-takes`);
    await expect(page.getByTestId("stock-take-row").first()).toBeVisible();
  });

  test("markdowns: suggestions above the floor, bulk apply with price history; loss report renders", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/inventory`);
    await page.getByTestId("markdowns-link").click();
    await expect(page).toHaveURL(/\/inventory\/markdowns$/);
    const rows = page.getByTestId("markdown-row");
    await expect(rows.first()).toBeVisible();
    const historyBefore = await page.getByTestId("price-change-row").count();
    await rows.first().getByTestId("markdown-select").click();
    await page.getByTestId("apply-markdowns").click();
    // one transaction and one platform write per variant: give the batch time under a loaded machine
    await expect(page.getByTestId("markdown-summary")).toContainText(/^1 /, { timeout: 30_000 });
    await expect.poll(() => page.getByTestId("price-change-row").count()).toBeGreaterThan(Math.min(historyBefore, 14));
    // the unexplained-loss report over the last 90 days shows the falls found by the syncs
    await page.goto(`${T}/inventory/losses?preset=90d`);
    await expect(page.getByTestId("loss-row").first()).toBeVisible();
  });

  test("a viewer sees the inventory control pages but no adjustment or apply controls", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto(`${T}/inventory`);
    await expect(page.getByTestId("adjust-stock")).toHaveCount(0);
    await page.goto(`${T}/inventory/markdowns`);
    await expect(page.getByTestId("apply-markdowns")).toHaveCount(0);
    await page.goto(`${T}/inventory/stock-takes`);
    await expect(page.getByTestId("create-stock-take")).toHaveCount(0);
  });
});
