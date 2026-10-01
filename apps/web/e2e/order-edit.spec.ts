import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

/** Opens the first open, prepaid card order of Harbor Home (no add-ons) that offers editing. */
async function openEditableCardOrder(page: Page, skip = 0): Promise<string> {
  await page.goto("/t/harbor-home/orders?status=confirmed&payment=card&paymentStatus=paid");
  const links = page.locator("table tbody tr").getByRole("link");
  await expect(links.first()).toBeVisible();
  const hrefs = (await links.evaluateAll((els) => els.map((e) => e.getAttribute("href")))).filter((h): h is string => Boolean(h && /\/orders\/[0-9a-f-]{36}$/.test(h)));
  let seen = 0;
  for (const href of [...new Set(hrefs)]) {
    await page.goto(href);
    if ((await page.getByTestId("edit-order").count()) === 0) continue;
    if (seen++ < skip) continue;
    return (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
  }
  throw new Error("no editable card order");
}

test.describe("core order editing (addon.cod off)", () => {
  test("operations changes the address of a prepaid card order: validated, written to the store, diff with author", async ({ page }) => {
    await login(page, "ops@harborhome.demo");
    await openEditableCardOrder(page);
    await expect(page.getByText(/Card|Carta/).first()).toBeVisible();
    await page.getByTestId("edit-order").click();
    const dialog = page.getByRole("dialog");
    // a malformed postal code is refused on the server, field by field
    await dialog.getByLabel(/^Postal code$/).fill("123");
    await page.getByTestId("edit-save").click();
    await expect(dialog.getByTestId("address-issue-zip")).toBeVisible();
    // autocomplete from the address provider (mock) fills street, city, state and zip
    await dialog.getByLabel(/^Address$/).fill("500 Congress Ave");
    await expect(dialog.getByTestId("address-suggestion").first()).toBeVisible();
    await dialog.getByTestId("address-suggestion").first().click();
    await expect(dialog.getByLabel(/^Postal code$/)).toHaveValue("78701");
    await dialog.getByTestId("check-address").click();
    await expect(dialog.getByTestId("address-ok")).toBeVisible();
    await page.getByTestId("edit-save").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("78701 Austin").first()).toBeVisible();
    const event = page.locator("li", { hasText: "Order modified" }).first();
    await expect(event).toBeVisible();
    await expect(event).toContainText("James Walker");
    await expect(event).toContainText("shippingAddress");
    await expect(event).toContainText("Written to shopify");
  });

  test("changing the lines of an open card order creates a linked replacement", async ({ page }) => {
    await login(page, "ops@harborhome.demo");
    const oldName = await openEditableCardOrder(page, 1);
    await page.getByTestId("edit-order").click();
    const qty = page.getByRole("dialog").locator('input[type="number"]').first();
    await qty.fill(String(Number(await qty.inputValue()) + 1));
    await expect(page.getByText(/keeps its creation day and attribution/)).toBeVisible();
    await page.getByRole("button", { name: "Replace order" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(oldName);
    const banner = page.getByTestId("lineage-banner");
    await expect(banner).toContainText("Created as replacement of");
    await expect(banner).toContainText(oldName);
    await expect(page.locator("li", { hasText: "Created as replacement" }).first()).toContainText(`Replaces ${oldName}`);
    // the replaced order is final: cancelled, linked forward, no more editing
    await banner.getByRole("link", { name: oldName }).click();
    await expect(page.getByTestId("lineage-banner")).toContainText("no longer counts in reports");
    await expect(page.getByText("Cancelled").first()).toBeVisible();
    await expect(page.getByTestId("edit-order")).toHaveCount(0);
  });

  test("a preset discount is applied to an open order and logged", async ({ page }) => {
    await login(page, "ops@harborhome.demo");
    await openEditableCardOrder(page);
    await page.getByTestId("apply-discount").click();
    await page.getByTestId("discount-preset-1000").click();
    await expect(page.getByTestId("discount-preview")).toContainText("new total");
    await expect(page.getByText(/refund .* to the customer from the store/)).toBeVisible();
    await page.getByTestId("discount-save").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const event = page.locator("li", { hasText: "Discount applied" }).first();
    await expect(event).toContainText("KEEL-10%");
    await expect(event).toContainText("James Walker");
    await expect(page.getByText(/KEEL-10%/).first()).toBeVisible();
  });

  test("marketing and viewer roles cannot edit orders", async ({ page }) => {
    await login(page, "marketing@harborhome.demo");
    await page.goto("/t/harbor-home/orders?status=confirmed&payment=card");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("edit-order")).toHaveCount(0);
    await expect(page.getByTestId("apply-discount")).toHaveCount(0);
    await page.context().clearCookies();
    await login(page, "viewer@northwind.demo");
    await page.goto("/t/northwind-apparel/orders?status=confirmed&payment=card");
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("edit-order")).toHaveCount(0);
  });
});
