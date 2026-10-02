import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tier 2 on a phone (#49, wave 2): customers, purchasing, discounts, segments and customer
 * campaigns, settings, users, integrations, profile, support, exports and the campaign detail
 * pages fit the screen (no sideways scroll) and their main actions work from a phone. Runs in the
 * mobile-* projects with one worker; what it writes is removed or harmless (a new supplier with a
 * unique name, an invitation it revokes, settings saved unchanged).
 */
test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";

async function noSideScroll(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(m.scroll, `${label} scrolls sideways (${m.scroll} > ${m.client})`).toBeLessThanOrEqual(m.client);
}

async function firstRecordHref(page: Page, path: RegExp): Promise<string | null> {
  const hrefs = await page.locator("main a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  return hrefs.find((h) => path.test(h.split("?")[0]!)) ?? null;
}

test("every Tier 2 page fits the phone screen", async ({ page }) => {
  test.setTimeout(420_000);
  await login(page, "owner@northwind.demo");
  const pages = [
    "/customers", "/customers/rfm", "/customers/predictions",
    "/purchasing", "/purchasing/suppliers", "/purchasing/new", "/purchasing/packs",
    "/discounts", "/discounts/new",
    "/segments", "/segments/new", "/segments/campaigns", "/segments/campaigns/new", "/segments/campaigns/settings",
    "/settings", "/settings/branding", "/settings/fulfilment", "/settings/ai", "/settings/mobile", "/settings/billing", "/settings/data-export",
    "/users", "/integrations", "/integrations/tracking", "/integrations/guide/shopify", "/integrations/guide/meta", "/integrations/guide/google", "/integrations/guide/warehouse",
    "/profile", "/support", "/exports", "/campaigns/creatives",
  ];
  for (const p of pages) {
    await page.goto(`${NW}${p}`);
    await noSideScroll(page, p);
  }
  // detail pages, reached from their lists
  const details: [string, RegExp][] = [
    ["/customers?sort=total_spent", /\/customers\/[0-9a-f-]{36}$/],
    ["/purchasing?status=received", /\/purchasing\/[0-9a-f-]{36}$/],
    ["/purchasing?status=draft", /\/purchasing\/[0-9a-f-]{36}$/],
    ["/discounts", /\/discounts\/[0-9a-f-]{36}$/],
    ["/discounts", /\/discounts\/pools\/[0-9a-f-]{36}$/],
    ["/segments", /\/segments\/[0-9a-f-]{36}$/],
    ["/segments/campaigns", /\/segments\/campaigns\/[0-9a-f-]{36}$/],
    ["/support", /\/support\/[0-9a-f-]{36}$/],
    ["/campaigns?preset=90d", /\/campaigns\/[0-9a-f-]{36}$/],
  ];
  for (const [list, re] of details) {
    await page.goto(`${NW}${list}`);
    const href = await firstRecordHref(page, re);
    if (!href) continue;
    await page.goto(href);
    await noSideScroll(page, href);
    // a draft PO opens its editor
    if (/\/purchasing\/[0-9a-f-]{36}$/.test(href) && list.includes("draft")) {
      await page.goto(`${href}/edit`);
      await noSideScroll(page, `${href}/edit`);
    }
    // the campaign's ad sets and ads
    if (/\/campaigns\/[0-9a-f-]{36}$/.test(href)) {
      const adSet = await firstRecordHref(page, /\/adsets\/[0-9a-f-]{36}$/);
      if (adSet) {
        await page.goto(adSet);
        await noSideScroll(page, adSet);
        const ad = await firstRecordHref(page, /\/ads\/[0-9a-f-]{36}$/);
        if (ad) {
          await page.goto(ad);
          await noSideScroll(page, ad);
        }
      }
    }
  }
});

test("lists are cards on the phone and row actions stay reachable", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/customers?sort=total_spent`);
  const row = page.getByTestId("customer-row").first();
  await expect(row).toBeVisible();
  // the header row is hidden and the card shows the facts a hidden column used to hide
  await expect(page.locator("main thead").first()).toBeHidden();
  await expect(row.locator("td[data-label]").first()).toBeVisible();
  // customer filters live in the sheet, with a chip once applied
  await page.getByTestId("filters-open").click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel(/^RFM tier$|^Fascia RFM$/).selectOption("champions");
  await expect(page).toHaveURL(/tier=champions/);
  await page.getByTestId("filters-done").click();
  await expect(page.getByTestId("chip-tier")).toBeVisible();
  await page.getByTestId("chip-tier").click();
  await expect(page).not.toHaveURL(/tier=/);
  // supplier editing (a hidden column before) is on the card
  await page.goto(`${NW}/purchasing/suppliers`);
  await expect(page.locator('[data-testid^="edit-supplier-"]').first()).toBeVisible();
  // segment row actions (export, evaluate, delete) are on the card
  await page.goto(`${NW}/segments`);
  await expect(page.getByTestId("segment-row").first().getByRole("link", { name: /Export CSV|Esporta CSV/ })).toBeVisible();
});

test("purchasing: create a supplier from the phone", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/purchasing/suppliers`);
  const name = `Mobile supplier ${Date.now()}`;
  const form = page.getByTestId("supplier-form");
  await form.getByLabel(/^Name$|^Nome$/).fill(name);
  await form.getByLabel(/^Email$/).fill("mobile-supplier@e2e.test");
  await form.getByRole("button", { name: /^Add$|^Aggiungi$/ }).click();
  await expect(page.getByTestId("supplier-row").filter({ hasText: name })).toBeVisible();
  await noSideScroll(page, "suppliers after create");
});

test("discounts: apply a state filter from the scrolling chips", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/discounts`);
  await expect(page.getByTestId("discount-row").first()).toBeVisible();
  // the chip row scrolls inside itself, never the page
  await noSideScroll(page, "discounts");
  await page.getByTestId("state-active").click();
  await expect(page).toHaveURL(/state=active/);
  await expect(page.getByTestId("state-active")).toHaveAttribute("aria-pressed", "true");
  const rows = page.getByTestId("discount-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText(/Active|Attivo/);
  await page.getByTestId("state-all").click();
  await expect(page).not.toHaveURL(/state=/);
});

test("settings: save the general settings from the phone", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/settings`);
  // the sub-pages are one scrolling row
  await expect(page.getByTestId("settings-subnav")).toBeVisible();
  await noSideScroll(page, "settings");
  await page.getByRole("button", { name: /^save$|^salva$/i }).first().click();
  await expect(page.getByText(/Saved\.|Salvato\./).first()).toBeVisible();
});

test("users: invite a teammate from the phone and revoke the invitation", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/users`);
  await page.getByTestId("invite-jump").click();
  const email = `mobile-invite-${Date.now()}@e2e.test`;
  const form = page.getByTestId("invite-form");
  await expect(form).toBeInViewport();
  await form.locator("#invite-email").fill(email);
  await form.locator("#invite-role").selectOption("viewer");
  await form.getByRole("button", { name: /^Invite$|^Invita$/ }).click();
  await expect(page.getByTestId("invite-result")).toBeVisible();
  const row = page.getByTestId("invitation-row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await row.getByTestId("invitation-revoke").click();
  await expect(row).toContainText(/Revoked|Revocat/);
  await noSideScroll(page, "users");
});

test("integrations: open a provider guide from its card", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/integrations`);
  await page.getByTestId("provider-shopify").getByRole("link", { name: /How to connect|Come collegarla/ }).click();
  await expect(page).toHaveURL(/\/integrations\/guide\/shopify$/);
  await expect(page.getByTestId("guide-step").first()).toBeVisible();
  // the provider tabs scroll inside their row
  const nav = page.getByTestId("guide-nav");
  const m = await nav.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).overflowX }));
  expect(m.overflow).toBe("auto");
  expect(m.scroll).toBeGreaterThanOrEqual(m.client);
  await nav.getByRole("link", { name: /^Meta/ }).first().click();
  await expect(page).toHaveURL(/\/integrations\/guide\/meta$/);
  await noSideScroll(page, "guide meta");
});

test("detail pages dock their primary action: PO editor save, segment save, customer campaign workflow", async ({ page }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`${NW}/purchasing/new`);
  const bar = page.locator("[data-sticky-actions]");
  await expect(bar.getByTestId("po-editor-submit")).toBeVisible();
  await expect(bar.getByTestId("po-editor-submit")).toBeInViewport();
  await page.goto(`${NW}/segments/new`);
  await expect(page.locator("[data-sticky-actions]").getByRole("button", { name: /Create segment|Crea segmento/ })).toBeInViewport();
  await page.goto(`${NW}/segments/campaigns`);
  const href = await firstRecordHref(page, /\/segments\/campaigns\/[0-9a-f-]{36}$/);
  if (href) {
    await page.goto(href);
    await noSideScroll(page, href);
  }
});
