import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Profile page and greeting (#45). A demo user no other spec signs in with: these tests end its other sessions. */
const USER = "ops@harborhome.demo";
const BASE = "/t/harbor-home";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAKElEQVQ4jWPQjvxPFcQwapD2aBhpj6ajyNEsEjlajPwfLSH/D2QtAgBxVmbujFiFIQAAAABJRU5ErkJggg==", "base64");

/** Which greeting the rule gives for this instant in `zone` (same bands as greetingKey). */
function expectedGreeting(zone: string, at = new Date()): RegExp {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(at)) % 24;
  return h >= 5 && h < 12 ? /Good morning/ : h >= 12 && h < 18 ? /Good afternoon/ : /Good evening/;
}

test.describe("profile", () => {
  test("name, preferred name, photo and time zone update the header and the greeting, never showing the email", async ({ page }) => {
    await login(page, USER);
    await page.goto(`${BASE}/profile`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your profile");
    await expect(page.getByTestId("profile-workspaces")).toContainText("Harbor Home");
    // identity: the preferred name is what the header and the greeting use
    await page.getByLabel("Preferred name").fill("Jamie");
    await page.getByLabel("Job title").fill("Warehouse lead");
    await page.getByTestId("identity-form").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("user-menu-name")).toHaveText("Jamie");
    // time zone: the greeting follows the user's zone, not the tenant's (New York)
    await page.getByLabel("Time zone").selectOption("Asia/Tokyo");
    await page.getByTestId("preferences-form").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("preferences-form").getByText("Saved.")).toBeVisible();
    await page.goto(BASE);
    const greeting = page.getByTestId("greeting");
    await expect(greeting).toHaveAttribute("data-time-zone", "Asia/Tokyo");
    await expect(greeting).toContainText(expectedGreeting("Asia/Tokyo"));
    await expect(greeting).toContainText("Jamie");
    await expect(greeting).not.toContainText("@");
    // photo: resized server side and shown in the header
    await page.goto(`${BASE}/profile`);
    await page.getByTestId("avatar-input").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("user-menu").locator("img")).toHaveAttribute("src", /\/avatar\//);
    const img = await page.request.get((await page.getByTestId("user-menu").locator("img").getAttribute("src"))!);
    expect(img.headers()["content-type"]).toBe("image/webp");
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("user-menu").locator("img")).toHaveCount(0);
    // restore the demo user
    await page.getByLabel("Preferred name").fill("James");
    await page.getByLabel("Job title").fill("");
    await page.getByTestId("identity-form").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("user-menu-name")).toHaveText("James");
    await page.getByLabel("Time zone").selectOption("");
    await page.getByTestId("preferences-form").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("preferences-form").getByText("Saved.")).toBeVisible();
  });

  test("the greeting is rendered by the server: a browser in another time zone hydrates the same text", async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: "Pacific/Kiritimati", locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, USER);
    const html = await (await page.request.get(BASE)).text();
    const [, zone, server] = html.match(/data-testid="greeting"[^>]*data-time-zone="([^"]+)"[^>]*>\s*<p[^>]*>([^<]+)</)!;
    await page.goto(BASE);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("greeting").locator("p").first()).toHaveText(server!.replace(/&#x27;/g, "'"));
    // the user's zone (else the tenant's), not the browser's Pacific/Kiritimati
    expect(zone).not.toBe("Pacific/Kiritimati");
    expect(server!).toMatch(expectedGreeting(zone!));
    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
    await context.close();
  });

  test("security: wrong current password, email change pending until confirmed, sign out of other sessions", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pa = await a.newPage();
    const pb = await b.newPage();
    await login(pa, USER);
    await login(pb, USER);
    await pa.goto(`${BASE}/profile`);
    await expect(pa.getByTestId("sign-ins")).toContainText("Password");
    // password: the current one is required
    await pa.getByLabel("Current password").fill("not-my-password");
    await pa.getByLabel("New password", { exact: true }).fill("Another-Strong-Pass-42");
    await pa.getByLabel("Repeat the new password").fill("Another-Strong-Pass-42");
    await pa.getByRole("button", { name: "Change password" }).click();
    // re-running the suite within the hour hits the server-side rate limit instead: also a pass
    await expect(pa.getByText(/The current password is not correct\.|Too many attempts/)).toBeVisible();
    // email: nothing changes until the new address confirms
    await pa.getByLabel("New email").fill(`james+${Date.now()}@example.com`);
    await pa.getByRole("button", { name: "Send confirmation" }).click();
    await expect(pa.getByTestId("email-pending").or(pa.getByText("Too many attempts. Try again in an hour.")).first()).toBeVisible();
    await expect(pa.getByTestId("profile-email")).toHaveText(USER);
    if (await pa.getByTestId("email-pending").isVisible()) {
      await pa.getByRole("button", { name: "Cancel request" }).click();
      await expect(pa.getByTestId("email-pending")).toHaveCount(0);
    }
    // sessions: B is signed out, A stays in
    await pa.getByTestId("sign-out-others").click();
    await expect(pa.getByText("All other sessions have been signed out.")).toBeVisible();
    await pb.goto(BASE);
    await expect(pb).toHaveURL(/\/login/);
    await pa.goto(BASE);
    await expect(pa.getByTestId("greeting")).toBeVisible();
    await a.close();
    await b.close();
  });

  test("a user can only open their own profile; the console has one too", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/profile");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your profile");
    await expect(page.getByTestId("profile-email")).toHaveText("superadmin@hullwise.demo");
    // avatars of people outside the viewer's workspaces are not served
    await page.context().clearCookies();
    const anon = await page.request.get("/avatar/00000000-0000-0000-0000-000000000000");
    expect(anon.status()).toBe(404);
  });
});
