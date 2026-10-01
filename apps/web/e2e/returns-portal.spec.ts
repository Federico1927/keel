import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

/** Recently delivered orders as the team sees them: number and customer email. */
async function deliveredOrders(page: Page): Promise<{ name: string; email: string }[]> {
  await page.goto(`${T}/orders?status=delivered`);
  const links = page.locator("table tbody tr td:first-child a");
  const hrefs = (await links.evaluateAll((els) => els.slice(0, 8).map((e) => (e as HTMLAnchorElement).href)));
  const out: { name: string; email: string }[] = [];
  for (const href of hrefs) {
    await page.goto(href);
    const html = await page.content();
    const name = /#NW-\d+/.exec(await page.locator("h1").first().innerText())?.[0];
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(html)?.[0];
    if (name && email) out.push({ name, email });
  }
  return out;
}

test.describe("customer return portal", () => {
  test("a customer returns an item through the portal and the team sees it, written to the store", async ({ page, browser }) => {
    await login(page, "owner@northwind.demo");
    const candidates = await deliveredOrders(page);
    expect(candidates.length).toBeGreaterThan(0);
    const customer = await browser.newContext();
    const c = await customer.newPage();
    let submitted: string | null = null;
    for (const o of candidates) {
      await c.goto("/r/northwind-apparel?lang=en");
      await expect(c.getByTestId("portal-title")).toHaveText("Return or exchange");
      await c.getByTestId("portal-shipped").click();
      await c.getByLabel("Order number").fill(o.name.replace("#NW-", ""));
      await c.getByLabel(/Email or phone/).fill(o.email);
      await c.getByTestId("portal-lookup").click();
      await expect(c.getByTestId("portal-line").first().or(c.getByTestId("portal-not-eligible"))).toBeVisible();
      if (await c.getByTestId("portal-not-eligible").isVisible()) continue;
      await c.getByTestId("portal-line").first().locator("select").selectOption("1");
      await c.getByLabel("Reason").selectOption("wrong_size");
      await c.getByLabel("You would like").selectOption("voucher");
      await c.getByLabel("Tracking code of the return").fill("rr 123 456 789 it");
      await c.getByLabel("I only tried the item on at home").check();
      await c.getByTestId("portal-confirm").check();
      await c.getByTestId("portal-submit").click();
      await expect(c.getByTestId("portal-done")).toBeVisible();
      submitted = (await c.getByTestId("portal-done").innerText()).match(/R-\d+/)![0];
      break;
    }
    await customer.close();
    expect(submitted).not.toBeNull();
    // the team: portal filter, badge, customer answers and the store write-back
    await page.goto(`${T}/returns`);
    await page.getByTestId("filter-portal").click();
    await page.getByRole("link", { name: submitted! }).click();
    await expect(page.getByTestId("return-source")).toHaveText(/Portal|Portale/);
    await expect(page.getByTestId("return-portal-card")).toContainText("RR123456789IT");
    await expect(page.getByTestId("return-portal-card")).toContainText(/I only tried|Ho provato/);
    // written to the (mock) store right after the submission; reload until the background write lands
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("return-sync-status")).toContainText(/Up to date|Allineato/);
    }).toPass({ timeout: 20_000 });
  });

  test("a customer exchanges for another size and sees the difference; the team sees the exchange", async ({ page, browser }) => {
    await login(page, "owner@northwind.demo");
    const candidates = await deliveredOrders(page);
    const customer = await browser.newContext();
    const c = await customer.newPage();
    let submitted: string | null = null;
    for (const o of candidates) {
      await c.goto("/r/northwind-apparel?lang=en");
      await c.getByTestId("portal-shipped").click();
      await c.getByLabel("Order number").fill(o.name.replace("#NW-", ""));
      await c.getByLabel(/Email or phone/).fill(o.email);
      await c.getByTestId("portal-lookup").click();
      await expect(c.getByTestId("portal-line").first().or(c.getByTestId("portal-not-eligible"))).toBeVisible();
      if (await c.getByTestId("portal-not-eligible").isVisible()) continue;
      await c.getByTestId("portal-line").first().locator("select").selectOption("1");
      await c.getByLabel("You would like").selectOption("exchange");
      const picker = c.getByTestId("portal-exchange").locator("select").first();
      if ((await c.getByTestId("portal-exchange").count()) === 0 || (await picker.locator("option").count()) < 2) continue;
      await picker.selectOption({ index: 1 });
      await expect(c.getByTestId("portal-difference")).toBeVisible();
      await c.getByLabel("Reason").selectOption("wrong_size");
      await c.getByTestId("portal-confirm").check();
      await c.getByTestId("portal-submit").click();
      await expect(c.getByTestId("portal-done")).toBeVisible();
      submitted = (await c.getByTestId("portal-done").innerText()).match(/R-\d+/)![0];
      break;
    }
    await customer.close();
    expect(submitted, "an order with another size in stock").not.toBeNull();
    await page.goto(`${T}/returns?q=${submitted}`);
    await page.getByRole("link", { name: submitted! }).click();
    await expect(page.getByTestId("return-exchange-card")).toBeVisible();
    await expect(page.getByTestId("exchange-difference")).toBeVisible();
  });

  test("an unknown order is refused without revealing anything, and a disabled store has no portal", async ({ page }) => {
    await page.goto("/r/northwind-apparel?lang=it");
    await page.getByRole("button", { name: "L'ho già spedito" }).click();
    await page.getByLabel("Numero d'ordine").fill("999999");
    await page.getByLabel(/Email o telefono/).fill("nobody@example.com");
    await page.getByTestId("portal-lookup").click();
    await expect(page.getByTestId("portal-error")).toContainText(/Non troviamo/);
    const res = await page.goto("/r/no-such-store");
    expect(res?.status()).toBe(404);
  });

  test("the team edits the portal texts and the write-back settings", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/returns`);
    await page.getByTestId("portal-settings-link").click();
    await expect(page.getByTestId("portal-url")).toHaveValue(/\/r\/northwind-apparel$/);
    const form = page.getByTestId("portal-config-form");
    await form.getByRole("tab", { name: "EN" }).click();
    const title = `Returns ${Date.now()}`;
    await form.getByLabel("Title").fill(title);
    await page.getByTestId("portal-save").click();
    await expect(form.getByText(/Saved|Salvato/)).toBeVisible();
    const behaviour = page.getByTestId("return-behaviour-form");
    await behaviour.getByLabel(/Refunded|Rimborsato/).fill("REFUNDED, RETURN-DONE");
    await page.getByTestId("behaviour-save").click();
    await expect(behaviour.getByText(/Saved|Salvato/)).toBeVisible();
    await page.goto("/r/northwind-apparel?lang=en");
    await expect(page.getByTestId("portal-title")).toHaveText(title);
    // restore the demo title
    await page.goto(`${T}/returns/portal`);
    await page.getByTestId("portal-config-form").getByRole("tab", { name: "EN" }).click();
    await page.getByTestId("portal-config-form").getByLabel("Title").fill("Return or exchange");
    await page.getByTestId("portal-save").click();
    await expect(page.getByTestId("portal-config-form").getByText(/Saved|Salvato/)).toBeVisible();
  });
});
