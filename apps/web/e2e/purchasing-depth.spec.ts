import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/harbor-home";

test.describe("purchasing depth", () => {
  test("new PO with a searched variant and a free-text line; edit, duplicate and delete", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/purchasing/new`);
    // start from an empty editor: remove the pre-filled suggestions
    const lines = page.getByTestId("po-line");
    while ((await lines.count()) > 0) await lines.first().getByRole("button", { name: /Delete|Elimina/ }).click();
    await page.getByTestId("po-variant-search").fill("a");
    await page.getByTestId("po-variant-search").fill("an");
    await page.getByTestId("po-variant-result").first().click();
    await expect(lines).toHaveCount(1);
    await page.getByTestId("po-add-free-text").click();
    await lines.nth(1).getByRole("textbox").fill("Hang tags");
    await lines.nth(1).getByRole("spinbutton").first().fill("100");
    await lines.nth(1).getByRole("spinbutton").nth(1).fill("0.15");
    await page.getByTestId("po-editor-submit").click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Hang tags")).toBeVisible();
    // edit: change the free-text quantity
    await page.getByTestId("po-edit").click();
    await expect(page).toHaveURL(/\/edit$/);
    await page.getByTestId("po-line").nth(1).getByRole("spinbutton").first().fill("200");
    await page.getByTestId("po-editor-submit").click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("po-history")).toContainText(/Edited/);
    // duplicate, then delete the copy
    await page.getByTestId("po-duplicate").click();
    await expect(page.getByTestId("po-history")).toContainText(/Created as a copy/);
    await page.getByTestId("po-delete").click();
    await page.getByTestId("po-delete-confirm").click();
    await expect(page).toHaveURL(new RegExp(`${T}/purchasing$`));
  });

  test("PO list filters by search and exports CSV", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/purchasing`);
    const filters = page.getByTestId("po-filters");
    await filters.getByLabel(/Search/).fill("PO-");
    await filters.getByRole("button", { name: /Apply/ }).click();
    await expect(page).toHaveURL(/q=PO-/);
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    const href = await page.getByTestId("po-export").getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect((await res.text()).split("\n")[0]).toContain("number,status,supplier");
  });

  test("receiving with inspection: damaged units are recorded", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/purchasing?status=confirmed`);
    if ((await page.locator("table tbody tr").count()) === 0) await page.goto(`${T}/purchasing?status=in_transit`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    const qty = page.locator('input[name^="qty_"]');
    const n = await qty.count();
    await qty.first().fill("3");
    for (let i = 1; i < n; i++) await qty.nth(i).fill("0");
    await page.locator('input[name^="dmg_"]').first().fill("1");
    await page.getByRole("button", { name: /^Receive$/ }).click();
    await expect(page.getByText(/Received\./)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/1 damaged · 0 rejected/).first()).toBeVisible();
  });

  test("default supplier from the product page, and the option-mix page creates a draft", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/products`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    const section = page.getByTestId("supplier-packs");
    await expect(section).toBeVisible();
    await section.getByTestId("bulk-supplier-open").click();
    const form = page.getByTestId("bulk-supplier-form");
    await form.getByLabel(/Lead time/).fill("12");
    await form.getByRole("button", { name: /^Save$/ }).click();
    await expect(form.getByText(/updated/)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByTestId("supplier-packs")).toContainText("12 d");
    await page.getByTestId("option-mix-link").click();
    await expect(page.getByTestId("mix-row").first()).toBeVisible();
    await page.getByRole("radio", { name: /By sales share/ }).click();
    await page.getByLabel(/Units to buy/).fill("24");
    await expect(page.getByTestId("mix-total-units")).toHaveText("24");
    await page.getByTestId("mix-create-po").click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/^Draft$/).first()).toBeVisible();
  });

  test("case packs page lists the seeded pack", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/purchasing/packs`);
    await expect(page.getByTestId("case-pack").first()).toBeVisible();
  });

  test("a revoked supplier link shows the neutral page and the PO shows the link states", async ({ page, browser }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(`${T}/purchasing?status=draft`);
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await page.getByTestId("po-send").click();
    const first = await page.getByTestId("supplier-link").inputValue();
    await page.getByTestId("po-send").click();
    await expect(page.getByTestId("supplier-link")).not.toHaveValue(first);
    const supplier = await browser.newContext();
    const sp = await supplier.newPage();
    await sp.goto(`${new URL(first).pathname}?lang=en`);
    await expect(sp.getByTestId("supplier-link-inactive")).toBeVisible();
    await expect(sp.locator("table")).toHaveCount(0);
    await supplier.close();
    await page.reload();
    await expect(page.getByTestId("supplier-links")).toContainText(/Revoked/);
    await expect(page.getByTestId("supplier-links")).toContainText(/1 view/);
    await page.getByTestId("supplier-link-revoke").click();
    await expect(page.getByText(/Link revoked\./)).toBeVisible();
  });
});
