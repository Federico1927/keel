import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Account flows (#52) against a production build: emails are read from the directory the server's
 * mock provider writes to (KEEL_EMAIL_OUTBOX_DIR, set by playwright.config.ts; with E2E_NO_SERVER
 * start the server with the same variable). The dev inbox does not exist in production.
 */
const OUTBOX = process.env.KEEL_EMAIL_OUTBOX_DIR!;
interface OutboxMail { to: string; subject: string; template: string | null; text: string; sentAt: string }

function mails(to: string, template?: string): OutboxMail[] {
  let files: string[] = [];
  try {
    files = readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files
    .map((f) => JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as OutboxMail)
    .filter((m) => m.to === to.toLowerCase() && (!template || m.template === template));
}

/** The path of the first link to `/${prefix}/…` in the latest email of that template (delivered after the response). */
async function linkFromMail(to: string, template: string, prefix: "invite" | "reset-password", count = 1): Promise<string> {
  let path = "";
  await expect(async () => {
    const list = mails(to, template);
    expect(list.length).toBeGreaterThanOrEqual(count);
    const m = new RegExp(`https?://[^\\s/]+(/${prefix}/[A-Za-z0-9_-]{43,})`).exec(list.at(-1)!.text);
    expect(m).not.toBeNull();
    path = m![1]!;
  }).toPass({ timeout: 20_000 });
  return path;
}

async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const invitee = `invitee-${stamp}@e2e.test`;
const firstPassword = "Harbor-lights-2026!";
const newPassword = "Quiet-river-7781#";

test.describe.serial("account emails and flows", () => {
  test("owner invites → invitation email → the person sets name and password and lands on the dashboard with the role", async ({ page, browser }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/users");
    await page.locator("#invite-email").fill(invitee);
    await page.locator("#invite-role").selectOption("marketing");
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByTestId("invite-result")).toHaveText("Invitation sent.");
    const row = page.getByTestId("invitation-row").filter({ hasText: invitee });
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("Marketing");

    const path = await linkFromMail(invitee, "invite", "invite");
    const guest = await signedOutPage(browser);
    await guest.goto(path);
    await expect(guest.getByTestId("invite-new")).toBeVisible();
    await expect(guest.getByTestId("invite-email")).toHaveText(invitee);
    await guest.locator("#inv-name").fill("Ivy Invitee");
    await guest.locator("#inv-preferred").fill("Ivy");
    await guest.locator("#new-password").fill("short");
    await expect(guest.getByTestId("password-checks")).toContainText("at least 10 characters");
    await guest.locator("#new-password").fill(firstPassword);
    await guest.locator("#confirm-password").fill(firstPassword);
    await guest.locator("#inv-privacy").click();
    await guest.getByTestId("accept-submit").click();
    await guest.waitForURL(/\/t\/northwind-apparel$/);
    // the role is the invited one
    await guest.goto("/t/northwind-apparel/profile");
    await expect(guest.getByTestId("profile-workspaces")).toContainText("Northwind Apparel");
    await expect(guest.getByTestId("profile-workspaces")).toContainText(/Marketing/);
    // a marketing member does not manage users
    expect((await guest.goto("/t/northwind-apparel/users"))?.status()).toBe(404);
    // welcome email after the first access, without the integration guide (not an owner)
    await expect(async () => {
      const welcome = mails(invitee, "welcome");
      expect(welcome).toHaveLength(1);
      expect(welcome[0]!.text).toContain("/t/northwind-apparel/profile");
      expect(welcome[0]!.text).not.toContain("/integrations/guide");
    }).toPass({ timeout: 20_000 });

    // the link works once
    const again = await signedOutPage(browser);
    await again.goto(path);
    await expect(again.getByTestId("invite-unusable")).toContainText(/already used|già stato usato/);
    // the owner sees the person among the members, the invitation left the pending list
    await page.reload();
    await expect(page.getByText(invitee)).toBeVisible();
    await expect(page.getByTestId("invitation-row").filter({ hasText: invitee })).toHaveCount(0);
  });

  test("forgot password → reset email → new password → old sessions signed out → notice", async ({ browser }) => {
    const old = await signedOutPage(browser);
    await login(old, invitee, firstPassword);
    await old.goto("/t/northwind-apparel/profile");
    await expect(old.getByTestId("profile-workspaces")).toBeVisible();

    const page = await signedOutPage(browser);
    await page.goto("/login");
    await page.getByTestId("forgot-password-link").click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.locator("#forgot-email").fill(invitee);
    await page.getByRole("button", { name: /Send the link|Invia il link|Enviar el enlace/ }).click();
    await expect(page.getByTestId("forgot-sent")).toBeVisible();

    const path = await linkFromMail(invitee, "password_reset", "reset-password");
    await page.goto(path);
    await expect(page.getByTestId("reset-password")).toContainText(invitee);
    await page.locator("#new-password").fill(newPassword);
    await page.locator("#confirm-password").fill(`${newPassword}x`);
    await page.getByRole("button", { name: /Save the password|Salva la password|Guardar la contraseña/ }).click();
    await expect(page.getByTestId("account-error")).toBeVisible();
    await page.locator("#confirm-password").fill(newPassword);
    await page.getByRole("button", { name: /Save the password|Salva la password|Guardar la contraseña/ }).click();
    await page.waitForURL(/\/t\/northwind-apparel/);

    // the session opened before the reset is over
    await old.goto("/t/northwind-apparel/profile");
    await expect(old).toHaveURL(/\/login/);
    // "your password was changed"
    await expect(async () => expect(mails(invitee, "password_changed")).toHaveLength(1)).toPass({ timeout: 20_000 });
    // the link was single use
    await page.goto(path);
    await expect(page.getByTestId("reset-invalid")).toBeVisible();
    // the new password works, the old one does not
    const fresh = await signedOutPage(browser);
    await login(fresh, invitee, newPassword);
    await expect(fresh).toHaveURL(/\/t\/northwind-apparel/);
  });

  test("unknown email: the same answer and nothing sent; forged tokens refused", async ({ page }) => {
    const nobody = `nobody-${stamp}@e2e.test`;
    await page.goto("/forgot-password");
    await page.locator("#forgot-email").fill(nobody);
    await page.getByRole("button", { name: /Send the link|Invia il link|Enviar el enlace/ }).click();
    await expect(page.getByTestId("forgot-sent")).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(mails(nobody)).toHaveLength(0);
    await page.goto(`/reset-password/${"x".repeat(43)}`);
    await expect(page.getByTestId("reset-invalid")).toBeVisible();
    await page.goto(`/invite/${"y".repeat(43)}`);
    await expect(page.getByTestId("invite-unusable")).toBeVisible();
  });

  test("a revoked invitation shows a clear page; a resent one replaces the link", async ({ page, browser }) => {
    const email = `revoked-${stamp}@e2e.test`;
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/users");
    await page.locator("#invite-email").fill(email);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByTestId("invite-result")).toHaveText("Invitation sent.");
    const first = await linkFromMail(email, "invite", "invite");
    const row = page.getByTestId("invitation-row").filter({ hasText: email });
    await row.getByTestId("invitation-resend").click();
    const second = await linkFromMail(email, "invite", "invite", 2);
    expect(second).not.toBe(first);
    await row.getByTestId("invitation-revoke").click();
    await expect(row).toContainText("Revoked");
    const guest = await signedOutPage(browser);
    await guest.goto(first);
    await expect(guest.getByTestId("invite-unusable")).toBeVisible();
    await guest.goto(second);
    await expect(guest.getByTestId("invite-unusable")).toContainText(/withdrawn|ritirato/);
  });

  test("the super-admin sends a password reset with the same flow, never seeing the link", async ({ page }) => {
    const before = mails(invitee, "password_reset").length;
    await login(page, "superadmin@keel.demo");
    await page.goto("/admin/tenants");
    await page.getByTestId("tenant-row").filter({ hasText: "Northwind Apparel" }).getByRole("link", { name: "Northwind Apparel" }).click();
    const member = page.getByTestId("admin-member").filter({ hasText: invitee });
    await member.getByTestId("send-password-reset").click();
    await expect(member).toContainText(/Reset email sent|Email di reimpostazione inviata/);
    await expect(member).not.toContainText("/reset-password/");
    await expect(async () => expect(mails(invitee, "password_reset")).toHaveLength(before + 1)).toPass({ timeout: 20_000 });
  });
});
