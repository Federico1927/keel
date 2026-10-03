import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tour of `addon.whatsapp_spoki` (#9) in mock mode on Northwind, as the product owner would take it
 * (docs/addons/whatsapp-spoki.md): the integration card, the settings, the conversations with the
 * team's reply and the 24-hour window, a simulated customer message, a COD confirmation sent from
 * the order and confirmed by the customer's WhatsApp reply. Desktop, then the same screens on an
 * iPhone 15 (light).
 */
test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";

async function dismissPrecheck(page: Page) {
  if ((await page.getByTestId("precheck-open").count()) > 0) await expect(page.getByTestId("precheck-open")).toHaveAttribute("data-ready", "true");
  if (await page.getByTestId("precheck-dialog").isVisible()) {
    await page.getByTestId("precheck-close").click();
    await expect(page.getByTestId("precheck-dialog")).toHaveCount(0);
  }
}

test.describe("addon.whatsapp_spoki tour", () => {
  test("integration card and settings: webhook URL, test connection, templates per event, COD reply keywords", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(NW);
    await page.getByRole("link", { name: /WhatsApp settings|Impostazioni WhatsApp|Ajustes de WhatsApp/ }).first().click();
    await page.waitForURL(/\/whatsapp\/settings/);
    await expect(page.getByTestId("whatsapp-tab-settings")).toHaveAttribute("aria-current", "page");
    const card = page.getByTestId("provider-spoki");
    await expect(card.getByTestId("spoki-mode")).toBeVisible();
    await card.getByTestId("spoki-test").click();
    await expect(page.getByTestId("msg-spoki")).toBeVisible();
    await card.getByTestId("spoki-manage").click();
    const sheet = page.getByTestId("integration-sheet");
    await expect(sheet.getByTestId("spoki-webhook-url")).toContainText("/api/webhooks/spoki/");
    await expect(sheet.getByRole("button", { name: /^Copy$|^Copia$/ }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("whatsapp-stats")).toBeVisible();
    await expect(page.getByTestId("tpl-cod:conferma")).toHaveValue("40101");
    await expect(page.getByTestId("tpl-campaign")).toHaveValue("40105");
    await expect(page.getByTestId("cod-replies-form")).toBeVisible();
    await expect(page.getByTestId("whatsapp-message").first()).toBeVisible();
  });

  test("conversations: the waiting customer gets the team's free-text reply within the 24-hour window", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${NW}/whatsapp/settings`);
    await page.getByTestId("whatsapp-tab-conversations").click();
    await page.waitForURL(/\/whatsapp$/);
    await expect(page.getByTestId("conversation-row").first()).toBeVisible();
    await expect(page.getByTestId("conversation-placeholder")).toBeVisible();
    await page.getByTestId("filter-awaiting").click();
    await page.waitForURL(/filter=awaiting/);
    // the seeded customer asking for delivery to their office (on a rerun against the same data: any waiting thread)
    const office = page.getByTestId("conversation-row").filter({ hasText: /ufficio|Via Roma/ });
    const waiting = (await office.count()) > 0 ? office.first() : page.getByTestId("conversation-row").first();
    await expect(waiting).toHaveAttribute("data-awaiting", "1");
    await waiting.getByTestId("conversation-link").click();
    await page.waitForURL(/thread=/);
    const thread = page.getByTestId("conversation-thread");
    if ((await thread.getByTestId("window-badge").getAttribute("data-open")) === "0") {
      await thread.getByTestId("simulate-inbound-send").click();
      await expect(async () => {
        await page.reload();
        await expect(thread.getByTestId("window-badge")).toHaveAttribute("data-open", "1");
      }).toPass({ timeout: 20_000, intervals: [1_000, 2_000] });
    }
    await expect(thread.getByTestId("window-badge")).toHaveAttribute("data-open", "1");
    await expect(thread.getByTestId("thread-message").last()).toHaveAttribute("data-direction", "inbound");
    const reply = `Certo, lo consegniamo in ufficio domani ${Date.now() % 1000}.`;
    await thread.getByTestId("reply-text").fill(reply);
    await thread.getByTestId("reply-send").click();
    await expect(thread.getByTestId("thread-message").last()).toContainText(reply);
    await expect(thread.getByTestId("thread-message").last()).toHaveAttribute("data-direction", "outbound");
    // answered: it leaves the "awaiting reply" list
    await page.goto(`${NW}/whatsapp?filter=awaiting`);
    await expect(page.getByTestId("conversation-row").filter({ hasText: reply })).toHaveCount(0);
  });

  test("a closed window refuses free text; a simulated customer message reopens it", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${NW}/whatsapp`);
    // a campaign recipient who never wrote: only templates can reach them
    await page.getByTestId("conversation-row").filter({ hasNotText: /ufficio|Via Roma/ }).nth(3).getByTestId("conversation-link").click();
    const thread = page.getByTestId("conversation-thread");
    if ((await thread.getByTestId("window-badge").getAttribute("data-open")) === "0") await expect(thread.getByTestId("reply-closed")).toBeVisible();
    const text = `Avete la taglia S? ${Date.now() % 1000}`;
    await thread.getByTestId("simulate-inbound-text").fill(text);
    await thread.getByTestId("simulate-inbound-send").click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("conversation-thread").getByTestId("thread-message").filter({ hasText: text })).toHaveAttribute("data-direction", "inbound");
    }).toPass({ timeout: 20_000, intervals: [1_000, 2_000] });
    await expect(page.getByTestId("conversation-thread").getByTestId("window-badge")).toHaveAttribute("data-open", "1");
    await expect(page.getByTestId("conversation-thread").getByTestId("reply-form")).toBeVisible();
  });

  test("COD: the confirmation goes out on WhatsApp from the order and the customer's “sì” confirms it", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${NW}/cod?view=all`);
    // an order of the queue nobody has messaged yet
    await page.getByTestId("queue-row").filter({ has: page.getByTestId("register-outcome") }).nth(4).getByRole("link").first().click();
    await expect(page.getByTestId("cod-card")).toBeVisible();
    await dismissPrecheck(page);
    const panel = page.getByTestId("messages-panel");
    await panel.getByTestId("template-send").click();
    await expect(panel.getByTestId("message-result")).toContainText(/#\d+|n\. \d+/);
    // the WhatsApp log of the order: the mapped Spoki template, sent
    const log = page.getByTestId("whatsapp-log");
    const sent = log.locator("[data-testid='whatsapp-message'][data-direction='outbound']").filter({ hasText: /COD confirmation|Conferma contrassegno/ }).first();
    await expect(sent).toBeVisible();
    await expect(sent).toContainText("cod_confirmation");
    // the customer reads it, then answers with the store's confirm keyword
    await sent.getByTestId("whatsapp-simulate").click();
    await page.getByTestId("simulate-read").click();
    await expect(log.locator("[data-testid='whatsapp-message'][data-status='read']").first()).toBeVisible({ timeout: 15_000 });
    await log.locator("[data-testid='whatsapp-message'][data-direction='outbound']").filter({ hasText: /COD confirmation|Conferma contrassegno/ }).first().getByTestId("whatsapp-simulate").click();
    await expect(page.getByTestId("simulate-reply")).toContainText("sì");
    await page.getByTestId("simulate-reply").click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("whatsapp-log").locator("[data-testid='whatsapp-message'][data-direction='inbound']").first()).toContainText("sì");
      await expect(page.getByTestId("cod-card")).toContainText(/^.*(Confirmed|Confermato)/);
    }).toPass({ timeout: 25_000, intervals: [1_000, 2_000, 3_000] });
    await expect(page.getByTestId("cod-card")).toContainText(/WhatsApp/);
  });

  test("operations has no WhatsApp pages", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    expect((await page.goto(`${NW}/whatsapp`))?.status()).toBe(404);
    expect((await page.goto(`${NW}/whatsapp/settings`))?.status()).toBe(404);
  });

  test("Harbor Home (add-on off) cannot reach the conversations", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    expect((await page.goto("/t/harbor-home/whatsapp"))?.status()).toBe(404);
  });
});

test.describe("addon.whatsapp_spoki tour · mobile-iphone15-light", () => {
  test.use({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light" });

  test("conversations list, a thread with the reply box and the way back; settings readable", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${NW}/whatsapp`);
    await expect(page.getByTestId("conversation-row").first()).toBeVisible();
    // no placeholder card on a phone: the list is the page
    await expect(page.getByTestId("conversation-placeholder")).toBeHidden();
    await page.getByTestId("conversation-row").first().getByTestId("conversation-link").click();
    await page.waitForURL(/thread=/);
    await expect(page.getByTestId("conversation-thread")).toBeVisible();
    await expect(page.getByTestId("conversation-list")).toBeHidden();
    await expect(page.getByTestId("thread-message").first()).toBeVisible();
    await page.getByTestId("thread-back").click();
    await expect(page.getByTestId("conversation-list")).toBeVisible();
    await page.getByTestId("whatsapp-tab-settings").click();
    await page.waitForURL(/\/whatsapp\/settings/);
    await expect(page.getByTestId("provider-spoki")).toBeVisible();
    await expect(page.getByTestId("whatsapp-settings-form")).toBeVisible();
    // nothing wider than the screen
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});
