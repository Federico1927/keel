import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reuse a preinstalled Chromium when PW_CHROMIUM_PATH (or the cloud default) exists. */
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const launchOptions = existsSync(chromiumPath) ? { executablePath: chromiumPath } : {};

/**
 * Where the server's mock email provider writes what it captures (#52): the account spec reads
 * invitation and reset links from there. With E2E_NO_SERVER, start the server with the same variable.
 */
process.env.HULLWISE_EMAIL_OUTBOX_DIR ??= join(tmpdir(), "hullwise-e2e-outbox");

/** iPhone 15 is a WebKit descriptor in Playwright: same viewport, scale and touch on Chromium (the browser available here). */
const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 15"];
const IPHONE_15 = { ...iphone, viewport: { width: 393, height: 852 }, browserName: "chromium" as const };
const { defaultBrowserType: _chromium, ...pixel } = devices["Pixel 7"];
const PIXEL_7 = { ...pixel, viewport: { width: 412, height: 915 }, browserName: "chromium" as const };
const MOBILE = [
  { name: "mobile-iphone15-light", device: IPHONE_15, scheme: "light" as const },
  { name: "mobile-iphone15-dark", device: IPHONE_15, scheme: "dark" as const },
  { name: "mobile-pixel7-light", device: PIXEL_7, scheme: "light" as const },
  { name: "mobile-pixel7-dark", device: PIXEL_7, scheme: "dark" as const },
];

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The console spec toggles add-ons and billing for the demo tenants: it runs after everything else.
  // Mobile projects (#49): the mobile-*.spec.ts flows at iPhone 15 (393×852) and Pixel 7 (412×915), light and dark,
  // on Chromium with touch (pointer: coarse). Run them alone with `--project=mobile-*` and one worker: they write demo data.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions }, testIgnore: /admin\.spec\.ts|mobile-.*\.spec\.ts/ },
    ...MOBILE.map((m) => ({ name: m.name, use: { ...m.device, colorScheme: m.scheme, launchOptions }, testMatch: /mobile-.*\.spec\.ts/ })),
    { name: "admin", use: { ...devices["Desktop Chrome"], launchOptions }, testMatch: /admin\.spec\.ts/, dependencies: ["chromium"] },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm start",
        url: "http://localhost:3000/login",
        reuseExistingServer: true,
        // loopback webhook receivers (api.spec.ts, #81) are allowed in this test server only
        env: { HULLWISE_EMAIL_OUTBOX_DIR: process.env.HULLWISE_EMAIL_OUTBOX_DIR, HULLWISE_WEBHOOKS_ALLOW_LOOPBACK: "1" },
        timeout: 120_000,
      },
});
