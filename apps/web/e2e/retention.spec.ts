import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("crm: customer campaigns with control group", () => {
  test("marketing reads a measured campaign and the waiting approvals", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/segments/campaigns");
    const rows = page.getByTestId("retention-row");
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId("campaign-status").filter({ hasText: /Waiting for approval|In approvazione/ }).first()).toBeVisible();
    await expect(page.getByTestId("campaign-status").filter({ hasText: /^Active$|^Attiva$/ }).first()).toBeVisible();
    await page.getByRole("link", { name: /Win-back clienti ricorrenti/ }).click();
    await expect(page.getByTestId("groups-table")).toBeVisible();
    await expect(page.getByText(/^Effect \+|^Effetto \+/)).toBeVisible();
    await expect(page.getByText(/BACK10/).first()).toBeVisible();
  });

  test("draft → test send → preview with exclusions → approval by the owner → scheduled send by the queue", async ({ browser }) => {
    const owner = await (await browser.newContext()).newPage();
    const marketing = await (await browser.newContext()).newPage();
    await login(owner, "owner@northwind.demo");
    await login(marketing, "marketing@northwind.demo");
    // every hour open, no lock or cap: the run does not depend on the clock or on earlier runs
    const settings = async (start: string, end: string, cap: string, lock: boolean) => {
      await owner.goto("/t/northwind-apparel/segments/campaigns/settings");
      await owner.locator("#campaignSendStartHour").fill(start);
      await owner.locator("#campaignSendEndHour").fill(end);
      await owner.locator("#campaignFrequencyCap").fill(cap);
      const box = owner.getByLabel(/Lock customers being measured|Blocca i clienti in misurazione/);
      if ((await box.isChecked()) !== lock) await box.click();
      await owner.getByRole("button", { name: /^Save$|^Salva$/ }).click();
      await expect(owner.getByTestId("settings-saved")).toBeVisible();
    };
    await settings("0", "24", "100", false);
    try {
      await marketing.goto("/t/northwind-apparel/segments/campaigns/new");
      const name = `E2E campaign ${Date.now()}`;
      await marketing.getByLabel(/^Name$|^Nome$/).fill(name);
      await marketing.getByLabel(/^Segment$|^Segmento$/).selectOption({ label: "Clienti ricorrenti" });
      await expect(marketing.getByTestId("holdout-hint")).toContainText(/%/);
      await marketing.getByLabel(/^Message$|^Messaggio$/).fill("Ciao {first_name}");
      await marketing.getByLabel(/Attribution window|Finestra di attribuzione/).fill("7");
      await marketing.getByRole("button", { name: /Create draft|Crea bozza/ }).click();
      await expect(marketing).toHaveURL(/\/segments\/campaigns\/[0-9a-f-]{36}$/);
      const url = marketing.url();
      // test send to the author, never an exposure
      await marketing.getByRole("button", { name: /Test send…|Invio di prova…/ }).click();
      await marketing.getByRole("button", { name: /^Send test$|^Invia prova$/ }).click();
      await expect(marketing.getByTestId("test-sent")).toBeVisible();
      await marketing.getByRole("button", { name: /^Close$|^Chiudi$/ }).first().click();
      // preview: who is left out and why, then submit
      await marketing.getByRole("button", { name: /Preview and submit…|Anteprima e invio in approvazione…/ }).click();
      await expect(marketing.getByTestId("send-preview")).toBeVisible({ timeout: 20_000 });
      for (const reason of ["no_consent", "suppressed", "over_cap", "open_order", "in_measurement", "holdout"]) await expect(marketing.getByTestId(`exclusion-${reason}`)).toBeVisible();
      await marketing.getByRole("button", { name: /^Submit for approval$|^Invia in approvazione$/ }).click();
      await expect(marketing.getByTestId("campaign-status")).toHaveText(/Waiting for approval|In approvazione/);
      await expect(marketing.getByTestId("approval-hint")).toContainText(/cannot approve your own|non puoi approvare una tua/);
      await expect(marketing.getByRole("button", { name: /^Approve$|^Approva$/ })).toHaveCount(0);
      // the owner approves and schedules for as soon as possible: the queue starts it and sends
      await owner.goto(url);
      await owner.getByRole("button", { name: /^Approve$|^Approva$/ }).click();
      await expect(owner.getByTestId("campaign-status")).toHaveText(/^Approved$|^Approvata$/);
      await owner.getByRole("button", { name: /Schedule…|Programma…/ }).click();
      await owner.getByRole("button", { name: /Send as soon as possible|Invia appena possibile/ }).click();
      await expect(async () => {
        await owner.reload();
        await expect(owner.getByTestId("campaign-status")).toHaveText(/Sending|Sent|In invio|Inviata/);
        await expect(owner.getByTestId("progress-count")).toHaveText(/^[1-9][\d.,]* \/ /);
      }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] });
      await expect(owner.getByTestId("campaign-workflow")).toContainText(/Approved|Approvata/);
    } finally {
      await settings("9", "20", "3", true);
    }
  });

  test("a viewer reads campaigns but cannot create, approve or send", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto("/t/northwind-apparel/segments/campaigns");
    await expect(page.getByTestId("retention-row").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /New campaign|Nuova campagna/ })).toHaveCount(0);
    await page.getByRole("link", { name: /Riattivazione alto valore/ }).click();
    await expect(page).toHaveURL(/\/segments\/campaigns\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("campaign-workflow")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Approve$|^Approva$/ })).toHaveCount(0);
    const res = await page.goto("/t/northwind-apparel/segments/campaigns/new");
    expect(res?.status()).toBe(404);
    expect((await page.goto("/t/northwind-apparel/segments/campaigns/settings"))?.status()).toBe(404);
  });
});

test.describe("crm: control groups belong to the customer-campaigns add-on", () => {
  test("a store without the add-on has plain segments: no campaigns tab, no holdout, no group column, page unreachable", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/segments");
    await expect(page.getByTestId("segment-row").first()).toBeVisible();
    await expect(page.locator('a[href$="/segments/campaigns"]')).toHaveCount(0);
    await page.getByTestId("segment-row").first().getByRole("link").first().click();
    await expect(page.getByTestId("member-row").first()).toBeVisible();
    await expect(page.getByLabel(/Holdout %/)).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: /^Group$/ })).toHaveCount(0);
    // core CRM still has the insights and the new fields
    await expect(page.getByTestId("segment-insights")).toBeVisible();
    await expect(page.getByTestId("insights-products").locator("li").first()).toBeVisible();
    await page.getByRole("button", { name: /^Condition$/ }).first().click();
    await page.getByTestId("rule-leaf").last().getByLabel("Field").selectOption("dominant_option");
    await expect(page.getByTestId("rule-leaf").last().getByLabel("Option")).toBeVisible();
    for (const path of ["/segments/campaigns", "/segments/campaigns/new", "/segments/campaigns/settings", "/segments/campaigns/00000000-0000-4000-8000-000000000000"]) {
      const res = await page.goto(`/t/harbor-home${path}`);
      expect(res?.status(), path).toBe(404);
    }
  });
});

test.describe("crm: live segments and audience destinations", () => {
  test("marketing sees the live repeat segment pushed to Meta, syncs it, and adds an email-tool destination", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/segments");
    await page.getByRole("link", { name: "Clienti ricorrenti" }).click();
    const card = page.getByTestId("segment-sync");
    await expect(card.getByTestId("live-toggle")).toBeChecked();
    const rows = card.getByTestId("destination-row");
    await expect(rows.first()).toContainText(/Meta/);
    expect(Number(await rows.first().getByTestId("destination-members").textContent())).toBeGreaterThan(0);
    await rows.first().getByRole("button", { name: /Sync now|Sincronizza ora/ }).click();
    await expect(rows.first()).toContainText(/synced|sincronizzata/, { timeout: 15_000 });
    const before = await rows.count();
    await card.getByLabel(/^Destination$|^Destinazione$/).selectOption("email_tool");
    await card.getByLabel(/Audience name|Nome del pubblico/).fill(`E2E list ${Date.now()}`);
    await card.getByRole("button", { name: /Add destination|Aggiungi destinazione/ }).click();
    await expect(rows).toHaveCount(before + 1, { timeout: 15_000 });
  });
});
