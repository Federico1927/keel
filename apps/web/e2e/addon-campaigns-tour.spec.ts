import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tour of `addon.customer_campaigns` (v1, #34/#38) in mock mode on Northwind, as the product owner
 * would take it (docs/addons/customer-campaigns.md): the campaign list with its history, a measured
 * WhatsApp campaign with treated vs control and its recipients, the scheduled and draft examples,
 * then a new WhatsApp campaign from draft to delivery through Spoki's simulated account (test send,
 * preview with exclusions, approval, scheduled send). Desktop, then the main screens on an iPhone 15 (light).
 */
test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";
const CAMPAIGNS = `${NW}/segments/campaigns`;

async function openCampaign(page: Page, name: RegExp) {
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL(/\/segments\/campaigns\/[0-9a-f-]{36}/);
}

/** Send window always open, no cap, no lock: the run does not depend on the clock or on earlier runs. */
async function campaignSettings(owner: Page, start: string, end: string, cap: string, lock: boolean, whatsappPerMinute: string) {
  await owner.goto(`${CAMPAIGNS}/settings`);
  await owner.locator("#throttleWhatsapp").fill(whatsappPerMinute);
  await owner.locator("#campaignSendStartHour").fill(start);
  await owner.locator("#campaignSendEndHour").fill(end);
  await owner.locator("#campaignFrequencyCap").fill(cap);
  const box = owner.getByLabel(/Lock customers being measured|Blocca i clienti in misurazione/);
  if ((await box.isChecked()) !== lock) await box.click();
  await owner.getByRole("button", { name: /^Save$|^Salva$/ }).click();
  await expect(owner.getByTestId("settings-saved")).toBeVisible();
}

test.describe("addon.customer_campaigns tour", () => {
  test("history: sent with measured uplift, scheduled, waiting for approval, draft, always-on sequence", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto(`${NW}/segments`);
    // the Segments | Campaigns tabs (the sidebar's "Campaigns" is the ads module)
    await page.locator("main a[href$='/segments/campaigns']").first().click();
    await page.waitForURL(/\/segments\/campaigns$/);
    const status = page.getByTestId("campaign-status");
    for (const s of [/^Sent$|^Inviata$/, /^Scheduled$|^Programmata$/, /Waiting for approval|In approvazione/, /^Draft$|^Bozza$/, /^Active$|^Attiva$/]) await expect(status.filter({ hasText: s }).first()).toBeVisible();
    await expect(page.getByText(/^Effect \+|^Effetto \+/).first()).toBeVisible();
  });

  test("a measured WhatsApp campaign: delivered through Spoki, treated vs control, the control group's customers", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto(CAMPAIGNS);
    await openCampaign(page, /Saldi di fine estate su WhatsApp/);
    await expect(page.getByTestId("campaign-delivery")).toHaveText(/Spoki/);
    await expect(page.getByTestId("groups-table")).toBeVisible();
    await expect(page.getByText(/^Effect \+|^Effetto \+/).first()).toBeVisible();
    await expect(page.getByText(/ESTATE20/).first()).toBeVisible();
    const recipients = page.getByTestId("campaign-recipients");
    await expect(recipients.getByTestId("recipient-row").first()).toHaveAttribute("data-group", "treated");
    await recipients.getByTestId("recipients-holdout").click();
    await page.waitForURL(/group=holdout/);
    const control = page.getByTestId("campaign-recipients").getByTestId("recipient-row");
    await expect(control.first()).toBeVisible();
    expect(await control.evaluateAll((rows) => rows.every((r) => r.getAttribute("data-group") === "holdout"))).toBe(true);
    await expect(control.first()).toContainText(/Control group|Gruppo di controllo/);
    await page.getByTestId("campaign-recipients").getByTestId("recipients-treated").click();
    await page.waitForURL(/group=treated/);
    await expect(page.getByTestId("campaign-recipients").getByTestId("recipient-row").first()).toContainText(/Delivered|Consegnat/);
  });

  test("the scheduled campaign shows when it starts; the draft on a segment without control warns", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto(CAMPAIGNS);
    await openCampaign(page, /Anteprima collezione inverno/);
    await expect(page.getByTestId("campaign-status")).toHaveText(/^Scheduled$|^Programmata$/);
    await expect(page.getByTestId("starts-at")).toBeVisible();
    await expect(page.getByTestId("campaign-workflow")).toContainText(/Approved|Approvata/);
    await page.goto(CAMPAIGNS);
    await openCampaign(page, /Benvenuto, secondo acquisto/);
    await expect(page.getByTestId("campaign-status")).toHaveText(/^Draft$|^Bozza$/);
    await expect(page.getByTestId("holdout-hint")).toBeVisible();
    await expect(page.getByTestId("channel-delivery")).toContainText(/simulated|simulato/);
  });

  test("a new WhatsApp campaign: draft → test on Spoki → preview → owner approves → sent through Spoki's simulated account", async ({ browser }) => {
    const owner = await (await browser.newContext()).newPage();
    const marketing = await (await browser.newContext()).newPage();
    await login(owner, "owner@northwind.demo");
    await login(marketing, "marketing@northwind.demo");
    await campaignSettings(owner, "0", "24", "100", false, "5000");
    try {
      await marketing.goto(`${CAMPAIGNS}/new`);
      const name = `Tour WhatsApp ${Date.now()}`;
      await marketing.getByLabel(/^Name$|^Nome$/).fill(name);
      await marketing.getByLabel(/^Segment$|^Segmento$/).selectOption({ label: "Inattivi da 120 giorni" });
      await expect(marketing.getByTestId("holdout-hint")).toContainText(/15/);
      await marketing.getByLabel(/^Channel$|^Canale$/).selectOption("whatsapp");
      await expect(marketing.getByTestId("channel-delivery")).toContainText(/Spoki/);
      await marketing.getByLabel(/^Message$|^Messaggio$/).fill("Ciao {first_name}, torna a trovarci: {code}");
      await marketing.getByLabel(/Discount code|Codice sconto/).fill("TOUR10");
      await marketing.getByLabel(/Attribution window|Finestra di attribuzione/).fill("7");
      await marketing.getByRole("button", { name: /Create draft|Crea bozza/ }).click();
      await expect(marketing).toHaveURL(/\/segments\/campaigns\/[0-9a-f-]{36}$/);
      const url = marketing.url();
      await expect(marketing.getByTestId("campaign-delivery")).toHaveText(/Spoki/);
      // test send to a phone of the team: through Spoki, never an exposure
      await marketing.getByRole("button", { name: /Test send…|Invio di prova…/ }).click();
      await marketing.getByLabel(/phone|telefono/i).fill("+39 333 123 4567");
      await marketing.getByRole("button", { name: /^Send test$|^Invia prova$/ }).click();
      await expect(marketing.getByTestId("test-sent")).toBeVisible();
      await marketing.getByRole("button", { name: /^Close$|^Chiudi$/ }).first().click();
      // the owner finds it in the WhatsApp log, sent with the template mapped to campaigns
      await owner.goto(`${NW}/whatsapp/settings`);
      await expect(owner.getByTestId("whatsapp-message").first()).toContainText(/Test message|Messaggio di prova/);
      await expect(owner.getByTestId("whatsapp-message").first()).toContainText("winback_offer");
      await marketing.getByRole("button", { name: /Preview and submit…|Anteprima e invio in approvazione…/ }).click();
      await expect(marketing.getByTestId("send-preview")).toBeVisible({ timeout: 20_000 });
      await expect(marketing.getByTestId("exclusion-holdout")).toBeVisible();
      await marketing.getByRole("button", { name: /^Submit for approval$|^Invia in approvazione$/ }).click();
      await expect(marketing.getByTestId("campaign-status")).toHaveText(/Waiting for approval|In approvazione/);
      // the owner approves and sends as soon as possible: the queue sends through Spoki
      await owner.goto(url);
      await owner.getByRole("button", { name: /^Approve$|^Approva$/ }).click();
      await expect(owner.getByTestId("campaign-status")).toHaveText(/^Approved$|^Approvata$/);
      await owner.getByRole("button", { name: /Schedule…|Programma…/ }).click();
      await owner.getByRole("button", { name: /Send as soon as possible|Invia appena possibile/ }).click();
      await expect(async () => {
        await owner.reload();
        await expect(owner.getByTestId("campaign-status")).toHaveText(/Sent|Inviata/);
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
      await expect(owner.getByTestId("groups-table")).toBeVisible();
      await expect(owner.getByTestId("campaign-recipients").getByTestId("recipient-row").first()).toBeVisible();
      // the messages are in the WhatsApp conversations, newest first
      await owner.goto(`${NW}/whatsapp`);
      await expect(owner.getByTestId("conversation-row").first()).toContainText(/TOUR10/);
    } finally {
      await campaignSettings(owner, "9", "20", "3", true, "60");
    }
  });

  test("a viewer reads campaigns and recipients but cannot act", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto(CAMPAIGNS);
    await openCampaign(page, /Saldi di fine estate su WhatsApp/);
    await expect(page.getByTestId("campaign-recipients")).toBeVisible();
    await expect(page.getByTestId("campaign-actions")).toHaveCount(0);
  });

  test("Harbor Home (add-on off) has no campaigns", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    expect((await page.goto("/t/harbor-home/segments/campaigns"))?.status()).toBe(404);
  });
});

test.describe("addon.customer_campaigns tour · mobile-iphone15-light", () => {
  test.use({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light" });

  test("list as cards, a measured campaign with groups and recipients, the new-campaign form", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto(CAMPAIGNS);
    await expect(page.getByTestId("retention-row").first()).toBeVisible();
    await openCampaign(page, /Saldi di fine estate su WhatsApp/);
    await expect(page.getByTestId("groups-table")).toBeVisible();
    await expect(page.getByTestId("campaign-recipients").getByTestId("recipient-row").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.goto(`${CAMPAIGNS}/new`);
    await expect(page.getByLabel(/^Segment$|^Segmento$/)).toBeVisible();
    await expect(page.getByTestId("holdout-hint")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});
