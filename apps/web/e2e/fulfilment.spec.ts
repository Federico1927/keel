import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("fulfilment (issue #28, Harbor Home: no add-on, prepaid orders)", () => {
  test("late-to-ship list → ship from the board → mock fulfilment, timeline event, the order leaves the queue", async ({ page }) => {
    await login(page, "ops@harborhome.demo");
    await page.goto("/t/harbor-home");
    await expect(page.getByRole("link", { name: /Late to ship/ })).toBeVisible();
    await page.goto("/t/harbor-home/fulfilment?view=late");
    const card = page.getByTestId("order-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("late-badge")).toBeVisible();
    const name = (await card.getAttribute("data-order"))!;
    const orderHref = (await card.getByRole("link", { name }).getAttribute("href"))!;
    // packing slip for this order is a PDF
    const pdf = await page.request.get(`/t/harbor-home/fulfilment/packing-slips?ids=${orderHref.split("/").pop()}`);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect((await pdf.body()).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");

    const tracking = `1Z${Date.now()}`;
    await card.getByTestId("ship").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Carrier").fill("UPS");
    await dialog.getByLabel("Tracking number").fill(tracking);
    await dialog.getByTestId("ship-submit").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // gone from the late queue, shown among today's shipments
    await expect(page.locator(`[data-testid="order-card"][data-order="${name}"]`)).toHaveCount(0);
    await expect(page.getByTestId("column-shipped").getByTestId("shipped-card").filter({ hasText: name })).toContainText(tracking);
    await page.reload();
    await expect(page.locator(`[data-testid="order-card"][data-order="${name}"]`)).toHaveCount(0);

    // the order timeline records the fulfilment with its author, the tracking and the platform write
    await page.goto(orderHref);
    const event = page.locator("li", { hasText: "Shipped from Keel" }).first();
    await expect(event).toBeVisible();
    await expect(event).toContainText("James Walker");
    await expect(event).toContainText(tracking);
    await expect(event).toContainText("Written to shopify");
    await expect(page.getByText(/Shipped/).first()).toBeVisible();
  });

  test("a delivery exception is claimed by one user only and its instruction cannot be sent twice", async ({ page, browser }) => {
    await login(page, "ops@harborhome.demo");
    await page.goto("/t/harbor-home/fulfilment/exceptions?scope=unclaimed");
    const row = page.getByTestId("case-row").first();
    await expect(row).toBeVisible();
    await row.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/fulfilment\/cases\/[0-9a-f-]{36}$/);
    const caseUrl = page.url();
    await expect(page.getByTestId("instruction-locked")).toBeVisible();
    await page.getByTestId("claim").click();
    await expect(page.getByTestId("case-owner")).toHaveText("Claimed by you.");

    // a colleague sees who owns it and cannot act
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await login(otherPage, "owner@harborhome.demo");
    await otherPage.goto(caseUrl);
    await expect(otherPage.getByTestId("case-owner")).toContainText("Claimed by James");
    await expect(otherPage.getByTestId("claim")).toHaveCount(0);
    await expect(otherPage.getByTestId("instruction-locked")).toBeVisible();
    await other.close();

    // the same case open in a second tab: the first send wins, the stale form is refused
    const second = await page.context().newPage();
    await second.goto(caseUrl);
    await expect(second.getByTestId("send-instruction")).toBeVisible();
    await page.getByLabel("What should the carrier do?").selectOption("redeliver");
    await page.getByTestId("send-instruction").click();
    await expect(page.getByTestId("instruction-sent")).toBeVisible();
    await expect(page.getByTestId("instruction-sent")).toContainText("Redeliver");
    await second.getByTestId("send-instruction").click();
    await expect(second.getByTestId("instruction-error")).toContainText("cannot be sent twice");
    await second.close();
  });

  test("the status mapping editor lives in settings", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto("/t/harbor-home/settings");
    await page.getByTestId("fulfilment-settings-link").click();
    await expect(page).toHaveURL(/\/settings\/fulfilment$/);
    const ext = `held_at_customs_${Date.now().toString(36)}`;
    const form = page.getByTestId("mapping-new");
    await form.getByLabel("External status").fill(ext);
    await form.getByLabel("Canonical status").selectOption("in_transit");
    await form.getByRole("checkbox", { name: "Exception" }).click();
    await page.getByTestId("mapping-add").click();
    await expect(page.locator(`[data-testid="mapping-row"][data-external="${ext}"]`)).toBeVisible();
  });
});
