import { devices, expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tour of addon.subscriptions (#67, v1 in development) on the demo, in mock mode: every screen and
 * action a product owner tries, on a desktop and on an iPhone 15 (light). Harbor Home sells refills
 * through the simulated Shopify Subscriptions app; the simulated app charges renewals (an order is
 * created), declines them (the recovery queue) and retries them. docs/addons/subscriptions.md
 * describes the same tour in words.
 */
const H = "/t/harbor-home/subscriptions";
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 15"];

test.describe.configure({ mode: "serial" });

test.describe("subscriptions tour · desktop", () => {
  test("overview: KPIs, MRR movement, cohorts, forecast, profit and LTV, every number drills down", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home");
    await page.locator("a[href='/t/harbor-home/subscriptions']").first().click();
    await page.waitForURL(/\/subscriptions$/);
    await expect(page.getByTestId("subs-kpis")).toContainText("MRR");
    await expect(page.getByTestId("subs-not-connected")).toHaveCount(0);
    await expect(page.getByTestId("mrr-row")).toHaveCount(12);
    await expect(page.getByTestId("cohort-row").first()).toBeVisible();
    await expect(page.getByTestId("subs-forecast")).toContainText("90 days");
    await expect(page.getByTestId("subs-profit")).toContainText("Profit");
    await expect(page.getByTestId("subs-acquisition").locator("tbody tr").first()).toBeVisible();
    await expect(page.getByTestId("subs-provider")).toContainText("Shopify Subscriptions");
    await page.getByRole("link", { name: "365 days" }).click();
    await page.waitForURL(/days=365/);
    // a cohort opens its subscribers
    await page.getByTestId("cohort-row").first().getByRole("link").click();
    await expect(page.getByTestId("subscriber-drilldown")).toContainText("Started in");
    await expect(page.getByTestId("subscriber-row").first()).toBeVisible();
  });

  test("subscribers: filters, search, ready-made segments, a subscriber's lines, charges, timeline and orders", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${H}/subscribers`);
    expect(await page.getByTestId("subscriber-row").count()).toBeGreaterThan(20);
    await page.getByLabel("Risk").selectOption("high");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.waitForURL(/risk=high/);
    await expect(page.getByTestId("subscriber-row").first()).toBeVisible();
    await page.goto(`${H}/subscribers?status=cancelled`);
    await expect(page.getByTestId("subscriber-row").first()).toContainText("Cancelled");
    await expect(page.getByTestId("ready-segments").locator("a").first()).toBeVisible();
    await page.goto(`${H}/subscribers?failing=1`);
    await page.getByTestId("subscriber-row").first().getByRole("link").first().click();
    await page.waitForURL(/subscribers\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("detail-failing")).toBeVisible();
    await expect(page.getByTestId("subscription-charges")).toContainText(/declined|expired|insufficient/i);
    await expect(page.locator("[data-testid=timeline-event][data-type=payment_failed]").first()).toBeVisible();
    await expect(page.getByTestId("contract-actions")).toBeVisible();
  });

  test("customer care: frequency, swap, reschedule and cancel with a reason, each written through the app with author and diff", async ({ page }) => {
    await login(page, "care@harborhome.demo");
    await page.goto(`${H}/subscribers?status=active&risk=low`);
    await page.getByTestId("subscriber-row").nth(2).getByRole("link").first().click();
    await page.waitForURL(/subscribers\/[0-9a-f-]{36}$/);
    await page.getByTestId("action-frequency").click();
    await page.locator("#freq-count").fill("2");
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("subscription-message")).toBeVisible();
    await expect(page.locator("[data-testid=timeline-event][data-type=frequency_changed]").first()).toContainText("Ava");
    await page.getByTestId("action-swap").click();
    const option = page.getByTestId("swap-variant").locator("option").nth(1);
    await page.getByTestId("swap-variant").selectOption(await option.getAttribute("value"));
    await page.getByTestId("action-confirm").click();
    await expect(page.locator("[data-testid=timeline-event][data-type=swapped]").first()).toBeVisible();
    await page.getByTestId("action-reschedule").click();
    const next = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
    await page.locator("#resched").fill(next);
    await page.getByTestId("action-confirm").click();
    await expect(page.locator("[data-testid=timeline-event][data-type=rescheduled]").first()).toBeVisible();
    await page.getByTestId("action-cancel").click();
    await page.getByTestId("cancel-reason").selectOption("too_much_product");
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("subscription-status")).toHaveText("Cancelled");
    await expect(page.getByTestId("detail-cancellation")).toContainText(/too much product/i);
  });

  test("the simulated app: a renewal creates its order, a declined card lands in recovery, the app's retry recovers it", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(H);
    await page.getByTestId("subs-simulate-success").click();
    const msg = page.getByTestId("subscription-message");
    await expect(msg).toContainText(/Renewal charged for .+: order #HH-\d+ created\./);
    const order = (await msg.textContent())!.match(/#HH-\d+/)![0];
    await page.goto(`/t/harbor-home/orders?subscription=renewal&q=${encodeURIComponent(order.slice(1))}`);
    await page.getByRole("link", { name: order }).first().click();
    await expect(page.getByTestId("order-subscription")).toContainText("Renewal");
    await page.goto(H);
    await page.getByTestId("subs-simulate-failure").click();
    await expect(msg).toContainText(/Renewal declined for (.+): it is now in the recovery queue/);
    const customer = (await msg.textContent())!.match(/declined for (.+?):/)![1]!;
    await page.goto(`${H}/recovery`);
    const row = page.getByTestId("recovery-row").filter({ hasText: customer }).first();
    await expect(row).toContainText("Card expired");
    await row.getByTestId("recovery-simulate-retry").click();
    await page.waitForURL(/recovery\?recovered=/);
    await expect(page.getByTestId("recovery-recovered")).toContainText(new RegExp(`retry went through for ${customer}: order #HH-\\d+ created, payment recovered`));
    await expect(page.getByTestId("recovery-row").filter({ hasText: customer })).toHaveCount(0);
    await page.getByTestId("recovery-recovered").getByRole("link", { name: "Open the order" }).click();
    await expect(page.getByTestId("order-subscription")).toContainText("Renewal");
  });

  test("recovery queue: assign, note, payment link through the app; filters by assignee", async ({ page }) => {
    await login(page, "care@harborhome.demo");
    await page.goto(`${H}/recovery`);
    await expect(page.getByTestId("recovery-kpis")).toContainText("Value at risk");
    const row = page.getByTestId("recovery-row").first();
    await row.getByLabel("Follow-up").selectOption({ label: "Ava" });
    await expect(page.getByTestId("subscription-message")).toHaveText("Follow-up assigned.");
    await row.getByTestId("recovery-link").click();
    await page.getByTestId("recovery-link-confirm").click();
    await expect(page.getByTestId("subscription-message")).toBeVisible();
    await row.getByTestId("recovery-note").click();
    await page.getByTestId("recovery-note-body").fill("Left a voicemail, will call back tomorrow");
    await page.getByTestId("recovery-note-save").click();
    await expect(page.getByTestId("subscription-message")).toHaveText("Note saved.");
    await page.goto(`${H}/recovery?assigned=me`);
    await expect(page.getByTestId("recovery-row").first()).toBeVisible();
  });

  test("stock for renewals, cancellation reasons by product, cohort and channel, the editable reason list", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${H}/stock?weeks=1`);
    await expect(page.locator("[data-testid=renewal-stock-row][data-short=true]")).toContainText("Candle Refill · Fig");
    await expect(page.getByTestId("stock-alerts")).toContainText("runs out on");
    for (const by of ["product", "cohort", "channel"]) {
      await page.goto(`${H}/cancellations?by=${by}`);
      await expect(page.getByTestId("reason-matrix").locator("tbody tr").first()).toBeVisible();
    }
    await expect(page.getByTestId("reason-breakdown")).toContainText(/Too expensive|Too much product/);
    await expect(page.getByTestId("reason-trend")).toBeVisible();
    const label = `Gift ended ${Date.now() % 100000}`;
    await page.getByLabel("Reason", { exact: true }).fill(label);
    await page.getByRole("button", { name: "Add reason" }).click();
    await expect(page.getByTestId("reason-row").filter({ hasText: label })).toHaveCount(1);
  });

  test("integration card: test connection, a simulated renewal from the menu, the activation guide", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/integrations");
    const card = page.getByTestId("provider-subscriptions");
    await expect(card).toContainText("Shopify Subscriptions");
    await card.getByTestId("subscriptions-test").click();
    await expect(card.getByTestId("msg-subscriptions")).toContainText("Connected");
    await card.getByTestId("subscriptions-simulate-menu").click();
    await page.getByTestId("simulate-subscriptions-renewal").click();
    await expect(page.getByTestId("msg-subscriptions")).toContainText(/Renewal charged for/);
    await page.goto("/t/harbor-home/integrations/guide/subscriptions");
    await expect(page.getByTestId("guide-step").first()).toBeVisible();
    await expect(page.getByText(/Recharge/).first()).toBeVisible();
  });

  test("the console shows the add-on active on Harbor Home with its version in development", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: "Harbor Home" }).first().click();
    await expect(page.getByTestId("addon-version-addon.subscriptions-1")).toContainText("in development");
    await expect(page.getByTestId("addon-addon.subscriptions")).toBeChecked();
  });
});

test.describe("subscriptions tour · mobile-iphone15-light", () => {
  test.use({ ...iphone, viewport: { width: 393, height: 852 }, colorScheme: "light" });

  test("every screen fits the phone: overview, subscribers as cards, a subscriber with its actions, recovery, stock, reasons", async ({ page }) => {
    await login(page, "care@harborhome.demo");
    for (const path of ["", "/subscribers", "/recovery", "/stock", "/cancellations"]) {
      await page.goto(`${H}${path}`);
      await expect(page.getByTestId("subscription-tabs")).toBeVisible();
      expect(await overflow(page), path || "/").toBeLessThanOrEqual(1);
    }
    await page.goto(`${H}/subscribers?status=active`);
    await expect(page.getByTestId("subscriber-table").locator("thead")).toBeHidden();
    await page.getByTestId("subscriber-row").nth(4).getByRole("link").first().click();
    await page.waitForURL(/subscribers\/[0-9a-f-]{36}$/);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.getByTestId("action-pause").click();
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("subscription-status")).toHaveText("Paused");
    await page.getByTestId("action-resume").click();
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("subscription-status")).toHaveText("Active");
    await page.goto(`${H}/recovery`);
    const row = page.getByTestId("recovery-row").first();
    await row.getByTestId("recovery-note").click();
    await page.getByTestId("recovery-note-body").fill("Texted the customer the update link");
    await page.getByTestId("recovery-note-save").click();
    await expect(page.getByTestId("subscription-message")).toHaveText("Note saved.");
  });

  test("the integration card and the guide on the phone", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/integrations");
    await expect(page.getByTestId("provider-subscriptions")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.getByTestId("subscriptions-manage").click();
    await expect(page.getByTestId("integration-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/t/harbor-home/integrations/guide/subscriptions");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});
