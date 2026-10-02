import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/** Issue #8: depth of the COD add-on on Northwind (addon.cod on), and its gating on Harbor Home. */
test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";

async function dismissPrecheck(page: Page) {
  // the dialog opens from an effect after hydration: wait for it to have run
  if ((await page.getByTestId("precheck-open").count()) > 0) await expect(page.getByTestId("precheck-open")).toHaveAttribute("data-ready", "true");
  if (await page.getByTestId("precheck-dialog").isVisible()) {
    await page.getByTestId("precheck-close").click();
    await expect(page.getByTestId("precheck-dialog")).toHaveCount(0);
  }
}

test.describe("addon.cod depth (#8)", () => {
  test("queue tiles with ages, sidebar badge, planned view, bulk distribute, home widgets", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${NW}/cod`);
    const tiles = page.getByTestId("queue-tiles");
    await expect(tiles.getByTestId("queue-tile-all")).toBeVisible();
    await expect(tiles.getByTestId("queue-tile-all")).toContainText(/avg age|età media/);
    await expect(page.getByTestId("nav-badge-cod_queue").first()).toBeVisible();
    // the seed plans one confirmation for a later day: its tile filters the list
    await tiles.getByTestId("queue-tile-planned").click();
    await expect(page).toHaveURL(/view=planned/);
    await expect(page.getByTestId("queue-row").first().getByTestId("planned-badge")).toBeVisible();
    // select two rows of the queue and split them equally among the operators on duty
    await page.goto(`${NW}/cod?view=all`);
    const rows = page.getByTestId("queue-row");
    await rows.nth(0).getByTestId("select-row").click();
    await rows.nth(1).getByTestId("select-row").click();
    await expect(page.getByTestId("bulk-bar")).toContainText(/2 selected|2 selezionati/);
    await page.getByTestId("bulk-distribute").click();
    await expect(page.getByTestId("bulk-result")).toContainText(/done|eseguiti/);
    // home widgets of the add-on (seeded on Northwind's home)
    await page.goto(NW);
    await expect(page.getByTestId("widget-cod_pending")).toBeVisible();
    await expect(page.getByTestId("widget-cod_mine")).toBeVisible();
    await expect(page.getByTestId("widget-cod_operators")).toBeVisible();
    await page.getByTestId("widget-cod_pending").click();
    await expect(page).toHaveURL(/\/cod$/);
  });

  test("order from the queue: navigator, warehouse list, message as attempt, escalation, planned confirmation", async ({ page }) => {
    await login(page, "care@northwind.demo");
    await page.goto(`${NW}/cod?view=all`);
    const row = page.getByTestId("queue-row").filter({ has: page.getByTestId("register-outcome") }).nth(1);
    const name = (await row.getByRole("link").first().textContent())!.trim();
    // the confirm dialog lists SKU × qty for the warehouse, with a copy button
    await row.getByTestId("register-outcome").click();
    await expect(page.getByTestId("warehouse-lines")).toContainText("×");
    await page.getByRole("button", { name: /^Cancel$|^Annulla$/ }).click();
    await row.getByRole("link").first().click();
    await expect(page).toHaveURL(/queue=all/);
    await expect(page.getByTestId("cod-card")).toBeVisible();
    await dismissPrecheck(page);
    await expect(page.getByTestId("queue-navigator")).toBeVisible();
    await expect(page.getByTestId("risk-panel")).toBeVisible();
    // confirmation template: filled with the order, sent through the (mock) channel, logged as an attempt
    const panel = page.getByTestId("messages-panel");
    await expect(panel.getByTestId("template-preview")).toContainText(name);
    await panel.getByTestId("template-send").click();
    await expect(panel.getByTestId("message-result")).toContainText(/#\d+|n\. \d+/);
    await expect(page.getByTestId("message-timeline").getByTestId("message-status").first()).toBeVisible();
    // escalate to an admin
    await page.getByTestId("transfer-menu").click();
    await page.getByTestId("escalate").click();
    await page.getByTestId("escalate-reason").fill("Chiede di parlare con un responsabile");
    await page.getByTestId("escalate-save").click();
    await expect(page.getByTestId("escalation-note")).toBeVisible();
    await page.goto(`${NW}/cod?view=escalated`);
    await expect(page.getByTestId("queue-row").filter({ hasText: name })).toHaveCount(1);
    // the customer agrees from a later day: confirmation scheduled, the row moves to Planned
    const target = page.getByTestId("queue-row").filter({ hasText: name });
    await target.getByTestId("register-outcome").click();
    await page.getByTestId("outcome-confirm_scheduled").click();
    const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    await page.getByTestId("confirm-on").fill(day);
    await page.getByRole("button", { name: /Save outcome|Salva esito/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto(`${NW}/cod?view=planned`);
    await expect(page.getByTestId("queue-row").filter({ hasText: name }).getByTestId("planned-badge")).toBeVisible();
  });

  test("team console: supervisor, efficiency with period, attribution list with links", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${NW}/cod/team`);
    await expect(page.getByTestId("supervisor-row").first()).toBeVisible();
    await page.getByTestId("team-tab-efficiency").click();
    await expect(page.getByTestId("efficiency-row").first()).toBeVisible();
    const operatorRow = page.getByTestId("efficiency-row").filter({ has: page.getByRole("link") }).first();
    await operatorRow.getByRole("link").first().click();
    await expect(page).toHaveURL(/tab=attribution/);
    await expect(page.getByTestId("attribution-row").first()).toBeVisible();
    await page.getByTestId("attribution-row").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  });

  test("settings: score preview, carrier import, queue behaviour; phones get cards", async ({ page }) => {
    await login(page, "admin@northwind.demo");
    await page.goto(`${NW}/cod?view=all`);
    const name = (await page.getByTestId("queue-row").first().getByRole("link").first().textContent())!.trim();
    await page.goto(`${NW}/cod/settings`);
    const preview = page.getByTestId("score-preview");
    await preview.getByTestId("preview-order").fill(name);
    await preview.getByTestId("preview-run").click();
    await expect(preview.getByTestId("preview-score")).toBeVisible();
    const carrier = page.getByTestId("carrier-import");
    await carrier.getByTestId("carrier-csv").fill(`order;esito;data;costo\n${name};consegnato;01/09/2026;6,90\nTRK-E2E-UNKNOWN;rifiutato;;13,40\n`);
    await carrier.getByTestId("carrier-submit").click();
    await expect(carrier.getByTestId("carrier-result")).toContainText(/2 rows|2 righe/);
    const ops = page.getByTestId("ops-settings");
    await ops.getByLabel(/Transfers per operator per day|Trasferimenti per operatore al giorno/).fill("3");
    await ops.getByTestId("save-ops").click();
    await expect(ops.getByText(/Saved\.|Salvato\./)).toBeVisible();
    await expect(page.getByTestId("templates-editor").getByTestId("template-row").first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${NW}/cod`);
    await expect(page.getByTestId("queue-card").first()).toBeVisible();
  });

  test("Harbor Home (no add-on): console and webhook unreachable", async ({ page, request }) => {
    await login(page, "owner@harborhome.demo");
    expect((await page.goto("/t/harbor-home/cod/team"))?.status()).toBe(404);
    const r = await request.post("/api/webhooks/cod-messaging/00000000-0000-0000-0000-000000000000/nope", { data: { messageId: "x", status: "read" } });
    expect(r.status()).toBe(404);
  });
});
