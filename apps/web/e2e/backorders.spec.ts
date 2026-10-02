import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/harbor-home";

/** Opens the "Awaiting stock" view and returns the order links it lists. */
async function awaitingOrders(page: Page) {
  await page.goto(`${T}/orders?stock=awaiting`);
  await expect(page.getByTestId("view-stock-awaiting")).toHaveAttribute("aria-pressed", "true");
  const links = page.locator("table tbody tr td a[href*='/orders/']");
  await expect(links.first()).toBeVisible();
  return (await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))).filter(Boolean);
}

test.describe("backorders", () => {
  test("an order waiting for stock shows the PO and ETA; receiving the PO releases it and it moves to Ready to release", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    const hrefs = await awaitingOrders(page);
    let found: string | null = null;
    for (const href of hrefs) {
      await page.goto(href);
      await expect(page.getByTestId("backorder-card")).toBeVisible();
      // receiving one PO must release the whole order: every waiting line covered, all by the same PO
      const rows = await page.getByTestId("backorder-row").count();
      const pos = await page.getByTestId("backorder-po").allTextContents();
      if (rows > 0 && pos.length === rows && new Set(pos).size === 1) {
        found = href;
        break;
      }
    }
    expect(found, "a seeded waiting order fully covered by one incoming PO").not.toBeNull();
    const card = page.getByTestId("backorder-card");
    await expect(card).toContainText("Waiting for stock");
    await expect(card.getByTestId("backorder-eta")).toContainText(/ETA/);
    await expect(page.getByText("On hold").first()).toBeVisible();
    // stock check per line: available, committed, incoming PO
    const check = page.getByTestId("stock-check-card");
    await expect(check).toBeVisible();
    await expect(check.getByTestId("stock-check-row").first()).toBeVisible();
    const orderName = (await page.locator("h1").first().textContent())!.trim();

    // receive the PO the order waits for
    await card.getByTestId("backorder-po").first().click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: /^Receive$/ }).click();
    // a complete receipt closes the form: the PO history records it
    await expect(page.getByTestId("po-history")).toContainText("Goods received");

    await page.goto(found!);
    await expect(page.getByTestId("backorder-card")).toContainText("Stock waits");
    await expect(page.getByTestId("backorder-cancel-wait")).toHaveCount(0);
    await expect(page.getByText("Hold released").first()).toBeVisible();
    await page.goto(`${T}/orders?stock=ready`);
    await expect(page.getByTestId("view-stock-ready")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("table tbody").getByText(orderName, { exact: true })).toBeVisible();
  });

  test("cancel wait releases an order from the Awaiting stock view", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    const [href] = await awaitingOrders(page);
    await page.goto(href!);
    await page.getByTestId("backorder-cancel-wait").click();
    await page.getByLabel("Note (optional)").fill("Shipping from the showroom");
    await page.getByTestId("backorder-cancel-wait-confirm").click();
    await expect(page.getByTestId("backorder-card")).toContainText("Stock waits");
    await expect(page.getByText("Wait cancelled by staff").first()).toBeVisible();
  });

  test("product page: option × option stock grid; dashboard: stock tile", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/products`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    const grid = page.getByTestId("stock-grid");
    await expect(grid).toBeVisible();
    await expect(grid.getByText("Stock by option")).toBeVisible();
    await expect(grid.getByTestId("stock-grid-total")).toBeVisible();
    await page.goto(T);
    const tile = page.getByTestId("stock-tile");
    await expect(tile).toBeVisible();
    await tile.getByTestId("stock-tile-holding").click();
    await expect(page).toHaveURL(/stock=awaiting/);
  });
});
