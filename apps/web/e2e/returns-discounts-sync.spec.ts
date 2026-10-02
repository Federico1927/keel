import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("discount pools and platform returns (issue #35)", () => {
  test("pool codes page: status per code, top-up, CSV export and deactivation synced to the store", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    // a fresh pool, so the run does not depend on what earlier runs did to the demo pool
    await page.goto("/t/northwind-apparel/discounts/new");
    await page.getByRole("button", { name: /Bulk pool|Pool in blocco/ }).click();
    await page.getByLabel(/^Title$|^Titolo$/).fill(`E2E lifecycle ${Date.now()}`);
    await page.getByLabel(/Number of codes|Numero di codici/).fill("5");
    await page.getByRole("button", { name: /Create pool|Crea pool/ }).click();
    await expect(page).toHaveURL(/\/discounts\/pools\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("pool-code-row")).toHaveCount(5);
    await expect(page.getByTestId("pool-code-status").first()).toHaveText(/Available|Disponibile/);

    // top-up to 8 ready codes
    await page.getByLabel(/Codes ready after the top-up|Codici pronti dopo la ricarica/).fill("8");
    await page.getByTestId("pool-top-up").click();
    await expect(page.getByTestId("pool-top-up-result")).toContainText(/3/);
    await expect(page.getByTestId("pool-code-row")).toHaveCount(8);

    // CSV of the codes with their status
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("pool-export").click()]);
    const csv = await readFile((await download.path())!, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("code,status,active,assigned_customer_email,assigned_campaign,assigned_at,redeemed_order,redeemed_at");
    expect(lines).toHaveLength(9);
    expect(lines.slice(1).every((l) => l.includes(",available,true,"))).toBe(true);

    // deactivate: every code off locally, the pool's discount off on the (mock) store through the outbox
    await page.getByTestId("pool-toggle").click();
    await page.getByRole("dialog").getByRole("button", { name: /Deactivate pool|Disattiva pool/ }).click();
    await expect(page.getByTestId("pool-state")).toHaveText(/Deactivated|Disattivato/);
    await expect(page.getByTestId("pool-filter-inactive")).toContainText("8");
    // synced: no pending or failed badge on the pool
    await expect(page.getByTestId("pool-sync")).toBeEmpty();
    await page.goto("/t/northwind-apparel/integrations");
    await expect(page.getByText(/Discount pool on\/off|Attivazione pool di sconti/).first()).toBeVisible();
  });

  test("a redeemed pool code shows the order that used it", async ({ page }) => {
    await login(page, "marketing@northwind.demo");
    await page.goto("/t/northwind-apparel/discounts");
    await page.getByTestId("pool-row").filter({ hasText: /win-back/ }).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/discounts\/pools\/[0-9a-f-]{36}$/);
    await page.getByTestId("pool-filter-redeemed").click();
    const row = page.getByTestId("pool-code-row").first();
    await expect(row.getByTestId("pool-code-status")).toHaveText(/Redeemed|Riscattato/);
    const orderName = (await row.getByTestId("pool-code-order").textContent())!.trim();
    expect(orderName).toMatch(/^#/);
    await row.getByRole("link").first().click();
    await expect(page.getByTestId("redeemed-order")).toHaveText(orderName);
    await page.getByTestId("redeemed-order").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(orderName);
  });

  test("a return opened on the store arrives by webhook and appears in the returns list", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    // mock-only simulations are in the card's "…" menu (#90)
    await page.getByTestId("shopify-simulate-menu").click();
    await page.getByTestId("simulate-return").click();
    await expect(page.getByTestId("msg-shopify")).toContainText(/HTTP 200/);
    const orderName = /(#[A-Z0-9-]+)/.exec((await page.getByTestId("msg-shopify").textContent()) ?? "")?.[1];
    expect(orderName).toBeTruthy();
    await expect
      .poll(async () => {
        await page.goto("/t/northwind-apparel/returns?source=platform");
        return page.getByTestId("return-row").filter({ hasText: orderName! }).count();
      }, { timeout: 15_000 })
      .toBe(1);
    const row = page.getByTestId("return-row").filter({ hasText: orderName! });
    await expect(row.getByTestId("return-source-platform")).toBeVisible();
    await expect(row).toContainText(/Requested|Richiesto/);
  });
});
