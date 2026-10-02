import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { login } from "./helpers";

/**
 * addon.subscriptions (#67) on the production build: Harbor Home has the add-on (refills sold through
 * the simulated Shopify Subscriptions app), Northwind does not and reaches none of it.
 */
const H = "/t/harbor-home/subscriptions";
const base = () => (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

test.describe.configure({ mode: "serial" });

test("overview: KPIs, MRR movement with drill-down, survival cohorts, forecast, profit and the app's health", async ({ page }) => {
  await login(page, "owner@harborhome.demo");
  await page.goto(H);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Subscriptions");
  await expect(page.getByTestId("subs-kpis")).toContainText("MRR");
  await expect(page.getByTestId("mrr-row")).toHaveCount(12);
  await expect(page.getByTestId("cohort-row").first()).toBeVisible();
  await expect(page.getByTestId("subs-forecast")).toContainText("30 days");
  await expect(page.getByTestId("subs-profit")).toContainText("Profit");
  await expect(page.getByTestId("subs-provider")).toContainText("Shopify Subscriptions");
  // a movement number opens the subscribers behind it
  const link = page.getByTestId("mrr-movement").locator("a").first();
  await link.click();
  await expect(page).toHaveURL(/subscribers\?movement=\d{4}-\d{2}:/);
  await expect(page.getByTestId("subscriber-drilldown")).toBeVisible();
  await expect(page.getByTestId("subscriber-row").first()).toBeVisible();
});

test("a customer-care user pauses and resumes a subscription, then skips the next renewal; the timeline shows who and what changed", async ({ page }) => {
  await login(page, "care@harborhome.demo");
  await page.goto(`${H}/subscribers?status=active`);
  await page.getByTestId("subscriber-row").first().getByRole("link").first().click();
  await page.waitForURL(/subscribers\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("subscription-status")).toHaveText("Active");
  await page.getByTestId("action-pause").click();
  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("subscription-message")).toHaveText("Subscription paused.");
  await expect(page.getByTestId("subscription-status")).toHaveText("Paused");
  // newest first: the pause just made
  const paused = page.locator("[data-testid=timeline-event][data-type=paused]").first();
  await expect(paused).toContainText("Ava");
  await expect(paused).toContainText("active → paused");
  await page.getByTestId("action-resume").click();
  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("subscription-status")).toHaveText("Active");
  await page.getByTestId("action-skip").click();
  await page.getByTestId("action-confirm").click();
  await expect(page.getByTestId("subscription-message")).toHaveText("Next renewal skipped.");
  await expect(page.locator("[data-testid=timeline-event][data-type=skipped]").first()).toContainText("nextBillingAt");
});

test("recovery queue, stock for renewals, cancellation reasons and the cards on customers and orders", async ({ page }) => {
  await login(page, "care@harborhome.demo");
  await page.goto(`${H}/recovery`);
  await expect(page.getByTestId("recovery-kpis")).toContainText("Value at risk");
  const row = page.getByTestId("recovery-row").first();
  await expect(row).toBeVisible();
  await row.getByTestId("recovery-note").click();
  await page.getByTestId("recovery-note-body").fill("Called the customer, card update promised");
  await page.getByTestId("recovery-note-save").click();
  await expect(page.getByTestId("subscription-message")).toHaveText("Note saved.");

  await page.goto(`${H}/stock?weeks=1`);
  const short = page.locator("[data-testid=renewal-stock-row][data-short=true]");
  await expect(short).toHaveCount(1);
  await expect(short).toContainText("Candle Refill · Fig");
  await expect(short.getByTestId("suggested-qty")).not.toHaveText("—");
  await expect(page.getByTestId("stock-alerts")).toContainText("runs out on");

  await page.goto(`${H}/cancellations?by=cohort`);
  await expect(page.getByTestId("reason-breakdown")).toContainText(/Payment failed|Too much product/);
  await expect(page.getByTestId("reason-matrix")).toBeVisible();

  // the subscription card on the customer page and on a subscription order
  await page.goto(`${H}/subscribers?status=active`);
  await page.getByTestId("subscriber-row").first().getByRole("link").first().click();
  await page.waitForURL(/subscribers\/[0-9a-f-]{36}$/);
  await page.locator("main a[href*='/customers/']").first().click();
  await expect(page.getByTestId("customer-subscriptions")).toBeVisible();
  await page.goto("/t/harbor-home/orders?subscription=renewal");
  await page.locator("a[href*='/orders/']").filter({ hasText: /HH-/ }).first().click();
  await expect(page.getByTestId("order-subscription")).toContainText("Renewal");
});

test("subscribers show as cards on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "owner@harborhome.demo");
  await page.goto(`${H}/subscribers`);
  await expect(page.getByTestId("subscriber-card").first()).toBeVisible();
  await expect(page.getByTestId("subscriber-table")).toBeHidden();
});

test("with the add-on off (Northwind) every page, the guide, the webhook and the MCP tools are unreachable", async ({ page, request }) => {
  await login(page, "owner@northwind.demo");
  for (const path of ["", "/subscribers", "/recovery", "/stock", "/cancellations", "/subscribers/00000000-0000-4000-8000-000000000000"]) {
    const res = await page.goto(`/t/northwind-apparel/subscriptions${path}`);
    expect(res?.status(), path).toBe(404);
  }
  expect((await page.goto("/t/northwind-apparel/integrations/guide/subscriptions"))?.status()).toBe(404);
  await page.goto("/t/northwind-apparel");
  await expect(page.locator("a[href='/t/northwind-apparel/subscriptions']")).toHaveCount(0);
  await page.goto("/t/northwind-apparel/integrations");
  await expect(page.getByTestId("provider-subscriptions")).toHaveCount(0);
  const hook = await request.post("/api/webhooks/subscriptions/00000000-0000-4000-8000-000000000000", { data: { id: "x" } });
  expect(hook.status()).toBe(404);
  // MCP (Northwind is on Growth): the subscription tools are not listed
  await page.goto("/t/northwind-apparel/profile");
  const form = page.getByTestId("mcp-create-token");
  await form.getByLabel(/name|nome|nombre/i).fill(`subs e2e ${Date.now()}`);
  await page.getByTestId("mcp-create-token-submit").click();
  const token = (await page.getByTestId("mcp-token-value").textContent())!.trim();
  const client = new Client({ name: "hullwise-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("get_cod_queue");
  expect(names).not.toContain("get_subscriptions_overview");
  expect(names).not.toContain("list_subscription_recovery");
  expect(names).not.toContain("get_renewal_stock");
  await client.close();
});
