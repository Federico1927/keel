import { expect, test } from "@playwright/test";
import { login } from "./helpers";

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
    // prefer an unassigned row so the claim path is exercised; fall back to any open row
    const unassigned = rows.filter({ has: page.getByTestId("claim") });
    const target = (await unassigned.count()) > 0 ? unassigned.first() : rows.first();
    const orderName = (await target.getByRole("link").first().textContent())!.trim();
    if ((await target.getByTestId("claim").count()) > 0) {
      await target.getByTestId("claim").click();
      await page.goto("/t/northwind-apparel/cod?view=mine");
      await expect(page.getByTestId("queue-row").filter({ hasText: orderName })).toHaveCount(1);
      await page.goto("/t/northwind-apparel/cod?view=all");
    }
    const mine = page.getByTestId("queue-row").filter({ hasText: orderName });
    await expect(mine).toHaveCount(1);
    for (let i = 0; i < 3; i++) {
      await mine.getByTestId("register-outcome").click();
      await page.getByTestId("outcome-no_answer").click();
      await page.getByRole("button", { name: /Save outcome|Salva esito/ }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      if (i < 2) await expect(mine).toContainText(String(i + 1));
    }
    await page.goto("/t/northwind-apparel/cod?view=unreachable");
    await expect(page.getByTestId("queue-row").filter({ hasText: orderName })).toHaveCount(1);
    // the order detail shows the explained score and the attempts, and the order is on hold
    await page.getByTestId("queue-row").filter({ hasText: orderName }).getByRole("link").first().click();
    await expect(page.getByTestId("cod-card")).toBeVisible();
    await expect(page.getByTestId("cod-card")).toContainText(/Contact attempts|Tentativi di contatto/);
    await expect(page.getByTestId("cod-card")).toContainText(/Attempts \(3\)|Tentativi \(3\)/);
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
  });

  test("admin configures operators, weights and risk; distribution follows hours; the add-on is unreachable for Harbor Home", async ({ page }) => {
    await login(page, "admin@northwind.demo");
    await page.goto("/t/northwind-apparel/cod/settings");
    await expect(page.getByTestId("capacity-row").first()).toBeVisible();
    const weightInput = page.getByLabel(/^Customer history|^Storico cliente/);
    await weightInput.fill("40");
    await page.locator("form").filter({ has: weightInput }).getByRole("button", { name: /^Save$|^Salva$/ }).click();
    await expect(page.getByText(/Saved\.|Salvato\./)).toBeVisible();
    await page.getByRole("button", { name: /Recompute from history|Ricalcola dallo storico/ }).click();
    await expect(page.getByText(/\d+ recipients|\d+ destinatari/)).toBeVisible();
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
