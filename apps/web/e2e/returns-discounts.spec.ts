import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("returns and discounts", () => {
  test("ops opens a return from a delivered order and walks it to refunded with restock", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/orders?status=delivered&sort=placed_desc");
    // find a recent delivered order with no return yet: open the first few until the request link is visible
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible();
    // earlier runs on the same database may have returned some orders already: take the first with something left to return
    let opened = false;
    const orderUrls = await rows.locator('a[href*="/orders/"]').evaluateAll((els) => els.slice(0, 12).map((e) => (e as HTMLAnchorElement).href));
    for (const url of orderUrls) {
      await page.goto(url);
      const link = page.getByRole("link", { name: /Request return|Apri reso/ });
      if ((await link.count()) === 0) continue;
      await link.click();
      await expect(page).toHaveURL(/\/returns\/new\?order=/);
      if ((await page.locator('input[type="number"]:not([disabled])').count()) > 0) {
        opened = true;
        break;
      }
    }
    expect(opened).toBe(true);
    const qty = page.locator('input[type="number"]:not([disabled])').first();
    await qty.fill("1");
    await page.getByRole("button", { name: /Open return|Apri reso/ }).click();
    await expect(page).toHaveURL(/\/returns\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/R-\d+/);

    await page.getByRole("button", { name: /^Approve$|^Approva$/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Approve$|^Approva$/ }).click();
    await expect(page.getByRole("button", { name: /Mark received|Segna ricevuto/ })).toBeVisible();
    await page.getByRole("button", { name: /Mark received|Segna ricevuto/ }).click();
    await expect(page.getByRole("dialog").getByText(/Put items back to stock|Rimetti gli articoli a stock/)).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: /Mark received|Segna ricevuto/ }).click();
    await expect(page.getByRole("button", { name: /Record inspection|Registra ispezione/ })).toBeVisible();
    await page.getByRole("button", { name: /Record inspection|Registra ispezione/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Record inspection|Registra ispezione/ }).click();
    await expect(page.getByRole("button", { name: /^Refund$|^Rimborsa$/ })).toBeVisible();
    await page.getByRole("button", { name: /^Refund$|^Rimborsa$/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Refund$|^Rimborsa$/ }).click();
    await expect(page.getByText(/Refunded|Rimborsato/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Refund$|^Rimborsa$/ })).toHaveCount(0);
    await expect(page.locator("table tbody tr").first()).toContainText(/Yes|Sì/);

    await page.goto("/t/northwind-apparel/returns/analytics?preset=ytd");
    await expect(page.getByText(/By reason|Per motivo/)).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("returns list filters by status and reasons can be added", async ({ page }) => {
    await login(page, "care@northwind.demo");
    await page.goto("/t/northwind-apparel/returns?status=open");
    await expect(page.getByTestId("return-row").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/returns/reasons");
    const code = `e2e_${Date.now().toString().slice(-6)}`;
    await page.getByLabel(/^Code$|^Codice$/).fill(code);
    await page.getByLabel(/^Label$|^Etichetta$/).fill("E2E reason");
    await page.getByRole("button", { name: /^Save$|^Salva$/ }).click();
    await expect(page.locator("table").getByText(code)).toBeVisible();
  });

  test("marketing creates a single code and a pool through the mock platform", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/discounts");
    await expect(page.getByTestId("discount-row").first()).toBeVisible();
    await expect(page.getByTestId("pool-row").first()).toBeVisible();
    await page.getByRole("link", { name: /New discount|Nuovo sconto/ }).click();
    const code = `E2E${Date.now().toString().slice(-6)}`;
    await page.getByLabel(/^Code$|^Codice$/).fill(code);
    await page.getByLabel(/^Title$|^Titolo$/).fill("E2E ten percent");
    await page.getByRole("button", { name: /Create code|Crea codice/ }).click();
    await expect(page).toHaveURL(/\/discounts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(code);
    await expect(page.getByText(/^Keel$/).last()).toBeVisible();

    await page.goto("/t/northwind-apparel/discounts/new");
    await page.getByRole("button", { name: /Bulk pool|Pool in blocco/ }).click();
    await page.getByLabel(/^Title$|^Titolo$/).fill(`E2E pool ${Date.now()}`);
    await page.getByLabel(/Number of codes|Numero di codici/).fill("25");
    await page.getByRole("button", { name: /Create pool|Crea pool/ }).click();
    await expect(page).toHaveURL(/\/discounts\?pool=/);
    await expect(page.getByTestId("discount-row")).toHaveCount(25);
  });
});
