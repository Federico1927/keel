import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

/** Opens the first order of a filtered order list. */
async function openFirstOrder(page: Page, listUrl: string): Promise<string> {
  await page.goto(listUrl);
  const links = page.locator("table tbody tr").getByRole("link");
  await expect(links.first()).toBeVisible();
  const href = (await links.evaluateAll((els) => els.map((e) => e.getAttribute("href")))).find((h): h is string => Boolean(h && /\/orders\/[0-9a-f-]{36}$/.test(h)));
  if (!href) throw new Error("no order in the list");
  await page.goto(href);
  return href;
}

test.describe("payments and money (issue #27)", () => {
  test("operations marks a bank-transfer order paid: out of pending, author on the timeline, pushed to the store", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await openFirstOrder(page, "/t/northwind-apparel/orders?payment=bank_transfer&paymentStatus=pending");
    await page.getByTestId("record-payment").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("payment-preview")).toContainText("marked paid");
    await page.getByTestId("payment-save").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("record-payment")).toHaveCount(0);
    const event = page.locator("li", { hasText: "Payment recorded" }).first();
    await expect(event).toBeVisible();
    await expect(event).toContainText("Sara Conti");
    await expect(event).toContainText("paymentStatus");
    await expect(page.getByTestId("order-transaction-manual_payment")).toContainText("Sara Conti");
    // a paid order can now be refunded instead
    await expect(page.getByTestId("refund-order")).toBeVisible();
  });

  test("a partial refund is recorded on the timeline; more than what remains is rejected", async ({ page }) => {
    await login(page, "ops@harborhome.demo");
    await openFirstOrder(page, "/t/harbor-home/orders?payment=card&paymentStatus=paid&status=delivered");
    await page.getByTestId("refund-order").click();
    await page.getByTestId("refund-amount").fill("10");
    await expect(page.getByTestId("refund-preview")).toContainText("$10.00");
    await page.getByTestId("refund-save").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const event = page.locator("li", { hasText: "Refund issued" }).first();
    await expect(event).toBeVisible();
    await expect(event).toContainText("James Walker");
    await expect(event).toContainText("$10.00 back to the customer");
    await expect(page.getByTestId("order-transaction-refund").first()).toContainText("−$10.00");
    await expect(page.getByText("Partially refunded").first()).toBeVisible();
    // the rest of the order is the limit
    await page.getByTestId("refund-order").click();
    await page.getByTestId("refund-amount").fill("100000");
    await expect(page.getByTestId("refund-too-much")).toBeVisible();
    await page.getByTestId("refund-save").click();
    await expect(page.getByTestId("payment-error")).toContainText("more than what remains refundable");
  });

  test("payouts page: each deposit with its orders, fees, refunds and net", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/analytics?tab=pnl");
    await expect(page.getByTestId("fee-sources")).toContainText("Payment fees from payouts");
    await page.getByTestId("payouts-link").click();
    await expect(page).toHaveURL(/\/analytics\/payouts$/);
    await expect(page.getByTestId("payout-row").first()).toBeVisible();
    await expect(page.getByTestId("payouts-last-sync")).toBeVisible();
    await page.getByTestId("sync-payouts").click();
    await expect(page.getByTestId("sync-payouts-result")).toContainText("payouts and");
    await page.goto("/t/northwind-apparel/analytics/payouts?status=paid");
    await page.getByTestId("payout-row").first().getByRole("link").click();
    await expect(page).toHaveURL(/\/analytics\/payouts\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("payout-transaction").first()).toBeVisible();
    await expect(page.getByTestId("payout-mismatch")).toHaveCount(0);
    // every charge links to its order, whose payments card shows the actual fee and the deposit
    await page.getByTestId("payout-transaction").filter({ hasText: "Charge" }).first().getByRole("link").click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("order-balance-transaction").first()).toContainText("fee");
    // a sale order (not a cancelled one) shows its P/L with the fee flagged as actual
    if (await page.getByTestId("economics-fee").count()) await expect(page.getByTestId("economics-fee")).toContainText("actual");
  });

  test("tax report matches the P/L tax line; payment methods cover every method", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/analytics?tab=tax");
    await expect(page.getByTestId("tax-row").first()).toBeVisible();
    await expect(page.getByTestId("tax-pnl-check")).toContainText("Matches the P/L tax line");
    await expect(page.getByTestId("tax-row").filter({ hasText: "IT" }).first()).toContainText("22");
    await page.goto("/t/northwind-apparel/analytics?tab=payments");
    for (const m of ["card", "wallet", "bank_transfer", "cod", "bnpl", "other"]) await expect(page.getByTestId(`method-${m}`)).toBeVisible();
    await page.getByTestId("method-card").getByRole("link").first().click();
    await expect(page).toHaveURL(/payment=card/);
  });
});
