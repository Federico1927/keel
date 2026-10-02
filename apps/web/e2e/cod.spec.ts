import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/** The pre-check dialog opens by itself on orders opened from the queue when the score flags something (#8). */
async function dismissPrecheck(page: Page) {
  // the dialog opens from an effect after hydration: wait for it to have run
  if ((await page.getByTestId("precheck-open").count()) > 0) await expect(page.getByTestId("precheck-open")).toHaveAttribute("data-ready", "true");
  if (await page.getByTestId("precheck-dialog").isVisible()) {
    await page.getByTestId("precheck-close").click();
    await expect(page.getByTestId("precheck-dialog")).toHaveCount(0);
  }
}

test.describe.configure({ mode: "serial" });

test.describe("addon.cod", () => {
  test("ops works the confirmation queue: scores, claim, outcomes, unreachable after three no-answers", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/cod?view=all");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/COD confirmation queue|Coda conferme contrassegno/);
    await page.getByRole("button", { name: /Recompute scores|Ricalcola punteggi/ }).click();
    await expect(page.getByText(/items scored|elementi ricalcolati/)).toBeVisible({ timeout: 30_000 });
    const rows = page.getByTestId("queue-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByTestId("score-badge")).toBeVisible();
    // prefer a row with no attempts yet and unassigned, so the claim path and all three no-answers are exercised
    const fresh = rows.filter({ has: page.locator("td:nth-child(5)", { hasText: /^\s*0\s*$/ }) });
    const pool = (await fresh.count()) > 0 ? fresh : rows;
    const unassigned = pool.filter({ has: page.getByTestId("claim") });
    const target = (await unassigned.count()) > 0 ? unassigned.first() : pool.first();
    const orderName = (await target.getByRole("link").first().textContent())!.trim();
    if ((await target.getByTestId("claim").count()) > 0) {
      await target.getByTestId("claim").click();
      // the claim is a server action: wait for the refreshed row before navigating, or the request can be cut off
      await expect(page.getByTestId("queue-row").filter({ hasText: orderName }).getByTestId("claim")).toHaveCount(0);
      await page.goto("/t/northwind-apparel/cod?view=mine");
      await expect(page.getByTestId("queue-row").filter({ hasText: orderName })).toHaveCount(1);
      await page.goto("/t/northwind-apparel/cod?view=all");
    }
    const mine = page.getByTestId("queue-row").filter({ hasText: orderName });
    await expect(mine).toHaveCount(1);
    const attemptsCell = mine.locator("td").nth(4);
    const start = Number((await attemptsCell.textContent())?.trim().match(/\d+/)?.[0] ?? 0);
    const needed = Math.max(1, 3 - start);
    for (let i = 0; i < needed; i++) {
      await mine.getByTestId("register-outcome").click();
      await page.getByTestId("outcome-no_answer").click();
      await page.getByRole("button", { name: /Save outcome|Salva esito/ }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // wait for the refreshed row before the next click, otherwise the click lands on a re-rendering row
      if (i < needed - 1) await expect(attemptsCell).toContainText(String(start + i + 1));
      await page.waitForLoadState("networkidle");
    }
    await page.goto("/t/northwind-apparel/cod?view=unreachable");
    await expect(page.getByTestId("queue-row").filter({ hasText: orderName })).toHaveCount(1);
    // the order detail shows the explained score and the attempts, and the order is on hold
    await page.getByTestId("queue-row").filter({ hasText: orderName }).getByRole("link").first().click();
    await expect(page.getByTestId("cod-card")).toBeVisible();
    await expect(page.getByTestId("cod-card")).toContainText(/Contact attempts|Tentativi di contatto/);
    await expect(page.getByTestId("cod-card")).toContainText(/Attempts \(\d+\)|Tentativi \(\d+\)/);
    await expect(page.getByText(/On hold|In attesa/).first()).toBeVisible();
  });

  test("a confirmed call moves the order to confirmed and out of the queue", async ({ page }) => {
    await login(page, "care@northwind.demo");
    await page.goto("/t/northwind-apparel/cod?view=all");
    const row = page.getByTestId("queue-row").filter({ has: page.getByTestId("register-outcome") }).first();
    await expect(row).toBeVisible();
    const orderName = (await row.getByRole("link").first().textContent())!.trim();
    await row.getByTestId("register-outcome").click();
    await page.getByTestId("outcome-confirmed").click();
    await page.getByRole("button", { name: /Save outcome|Salva esito/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("queue-row").filter({ hasText: orderName })).toHaveCount(0);
    await page.goto(`/t/northwind-apparel/orders?q=${encodeURIComponent(orderName)}`);
    await expect(page.locator("table tbody tr").first()).toContainText(/Confirmed|Confermato/);
    // the configured confirmation tag was written (mock platform) and the queue tag removed
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByText("confermato", { exact: true })).toBeVisible();
    await expect(page.getByText("da confermare", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Tags updated|Tag aggiornati/).first()).toBeVisible();
  });

  test("operator modifies a COD order before confirmation: contact in place, line change replaces the order", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto("/t/northwind-apparel/cod?view=all");
    const row = page.getByTestId("queue-row").filter({ has: page.getByTestId("register-outcome") }).first();
    await expect(row).toBeVisible();
    await row.getByRole("link").first().click();
    await expect(page.getByTestId("cod-card")).toBeVisible();
    await dismissPrecheck(page);
    // 1. contact change in place
    await page.getByTestId("modify-order").click();
    await page.getByLabel(/^Phone$|^Telefono$/).fill("+39 333 000 1111");
    await page.getByTestId("modify-save").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/Order modified|Ordine modificato/).first()).toBeVisible();
    await expect(page.getByText(/Attempts \(\d+\)|Tentativi \(\d+\)/)).toBeVisible();
    // 2. quantity change → replacement order, operator lands on the new one
    const oldName = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
    await page.getByTestId("modify-order").click();
    const qty = page.getByRole("dialog").locator('input[type="number"]').first();
    await qty.fill(String(Number(await qty.inputValue()) + 1));
    await expect(page.getByRole("button", { name: /Replace order|Sostituisci ordine/ })).toBeVisible();
    await page.getByTestId("modify-save").click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(oldName);
    await expect(page.getByText(/Created as replacement|Creato in sostituzione/).first()).toBeVisible();
    await expect(page.getByTestId("cod-card")).toBeVisible();
    await expect(page.getByText("da confermare", { exact: true })).toBeVisible();
  });

  test("admin configures operators, weights and risk; distribution follows hours; the add-on is unreachable for Harbor Home", async ({ page }) => {
    await login(page, "admin@northwind.demo");
    await page.goto("/t/northwind-apparel/cod/settings");
    await expect(page.getByTestId("capacity-row").first()).toBeVisible();
    const weightInput = page.getByLabel(/^Customer history|^Storico cliente/);
    await weightInput.fill("40");
    await page.locator("form").filter({ has: weightInput }).getByRole("button", { name: /^Save$|^Salva$/ }).click();
    await expect(page.getByText(/Saved\.|Salvato\./)).toBeVisible();
    // tag vocabulary is tenant configuration: read tags, written tags per event, operator allowed tags
    const tagForm = page.getByTestId("tag-settings");
    await expect(tagForm.getByLabel(/Queue tags|Tag di coda/)).toHaveValue(/Da confermare/);
    await tagForm.getByLabel(/Queue tags|Tag di coda/).fill("Da confermare, Da chiamare, Richiesta modifica, Urgente");
    await page.getByTestId("save-tags").click();
    await expect(tagForm.getByText(/Saved\.|Salvato\./)).toBeVisible();
    await page.goto("/t/northwind-apparel/cod");
    await expect(page.getByTestId("tag-filter")).toContainText("Urgente");
    await expect(page.getByTestId("entry-tag").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/cod/settings");
    await page.getByRole("button", { name: /Recompute from history|Ricalcola dallo storico/ }).click();
    // recomputing every recipient profile from the order history takes a while on the full demo
    await expect(page.getByText(/\d+ recipients|\d+ destinatari/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("risk-row").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/cod?view=unassigned");
    await page.getByTestId("distribute").click();
    await expect(page.getByText(/assigned|assegnati/).first()).toBeVisible();

    await page.goto("/t/harbor-home/cod");
    // admin@northwind has no membership in Harbor Home: 404 either way; owner of Harbor Home lacks the add-on
    await page.context().clearCookies();
    await login(page, "owner@harborhome.demo");
    const res = await page.goto("/t/harbor-home/cod");
    expect(res?.status()).toBe(404);
    const res2 = await page.goto("/t/harbor-home/cod/settings");
    expect(res2?.status()).toBe(404);
  });
});
