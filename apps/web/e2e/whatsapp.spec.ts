import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

/** The Spoki WhatsApp add-on (issue #9): active on Northwind, off on Harbor Home. */
test.describe("addon.whatsapp_spoki", () => {
  test("owner edits the settings: connection, templates per event, opt-out keywords", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel");
    const nav = page.getByRole("link", { name: /WhatsApp settings|Impostazioni WhatsApp|Ajustes de WhatsApp/ }).first();
    await expect(nav).toBeVisible();
    await nav.click();
    await page.waitForURL(/\/whatsapp\/settings/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("WhatsApp (Spoki)");
    const card = page.getByTestId("provider-spoki");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("spoki-webhook-url")).toContainText("/api/webhooks/spoki/");
    await expect(page.getByTestId("whatsapp-stats")).toBeVisible();
    // the demo maps a template to every event, COD confirmations included
    await expect(page.getByTestId("tpl-order_shipped")).toHaveValue("40103");
    await expect(page.getByTestId("template-row-cod-conferma")).toBeVisible();
    await page.getByTestId("wa-sender").fill("+390212345678");
    await page.getByTestId("save-whatsapp").click();
    await expect(page.getByTestId("whatsapp-saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("wa-sender")).toHaveValue("+390212345678");
    // resync reads the simulated account's templates
    await card.getByTestId("spoki-resync").click();
    await expect(card.getByTestId("msg-spoki")).toContainText(/6/);
    // the log of the whole store, newest first
    await expect(page.getByTestId("whatsapp-message").first()).toBeVisible();
  });

  test("the order page shows the message log; a simulated read receipt updates it and the timeline has the message", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/whatsapp/settings");
    // an order notification still at "delivered", reached from the log
    const row = page.locator("[data-testid='whatsapp-message'][data-status='delivered']").filter({ has: page.locator("a[href*='/orders/']") }).first();
    await expect(row).toBeVisible();
    await row.locator("a[href*='/orders/']").first().click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}/);
    const log = page.getByTestId("whatsapp-log");
    await expect(log).toBeVisible();
    const delivered = log.locator("[data-testid='whatsapp-message'][data-status='delivered']").first();
    await expect(delivered).toBeVisible();
    const before = await log.locator("[data-testid='whatsapp-message'][data-status='read']").count();
    await delivered.getByTestId("whatsapp-simulate").click();
    await page.getByTestId("simulate-read").click();
    await expect(log.locator("[data-testid='whatsapp-message'][data-status='read']")).toHaveCount(before + 1, { timeout: 15_000 });
    await expect(page.getByText(/WhatsApp message sent|Messaggio WhatsApp inviato/).first()).toBeVisible();
  });

  test("a wrong webhook token is a 404", async ({ request }) => {
    const res = await request.post("/api/webhooks/spoki/00000000-0000-4000-8000-000000000000/not-the-token", { data: { event: "message.outbound", data: { uuid: "x", send_status: "Read" } } });
    expect(res.status()).toBe(404);
  });

  test("Harbor Home (add-on off): page, guide, nav entry and integration card are unreachable", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    const res = await page.goto("/t/harbor-home/whatsapp/settings");
    expect(res?.status()).toBe(404);
    const guide = await page.goto("/t/harbor-home/integrations/guide/spoki");
    expect(guide?.status()).toBe(404);
    await page.goto("/t/harbor-home/integrations");
    await expect(page.getByTestId("provider-shopify")).toBeVisible();
    await expect(page.getByTestId("provider-spoki")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /WhatsApp settings/ })).toHaveCount(0);
  });
});
