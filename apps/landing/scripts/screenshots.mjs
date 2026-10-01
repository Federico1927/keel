/**
 * Captures the landing in every locale, desktop and mobile, into docs/landing/.
 * Builds nothing: run `pnpm --filter @keel/landing build` first. Starts its own static server.
 *
 *   pnpm --filter @keel/landing screenshots
 *   OUT_DIR=/tmp/shots LOCALES=en pnpm --filter @keel/landing screenshots
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;
const OUT = resolve(process.env.OUT_DIR ?? "../../docs/landing");
const LOCALES = (process.env.LOCALES ?? "en,it").split(",");
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

function startServer() {
  const child = spawn(process.execPath, ["scripts/serve.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  return child;
}

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not reachable at ${url}`);
}

async function main() {
  const server = startServer();
  try {
    await waitFor(`${BASE}/`);
    mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch(
      existsSync(chromiumPath) ? { executablePath: chromiumPath } : {},
    );
    for (const locale of LOCALES) {
      for (const [device, viewport] of Object.entries(VIEWPORTS)) {
        const { deviceScaleFactor, isMobile, hasTouch, ...size } = viewport;
        const context = await browser.newContext({
          viewport: size,
          deviceScaleFactor,
          isMobile,
          hasTouch,
          locale,
        });
        const page = await context.newPage();
        await page.goto(`${BASE}${locale === "en" ? "/" : `/${locale}/`}`);
        await page.waitForLoadState("networkidle");
        // A sticky header would be painted mid-page in a full-page capture.
        await page.addStyleTag({ content: "header { position: static !important; }" });
        // Below-the-fold screenshots are lazy: force them to load so the full-page capture is complete.
        await page.evaluate(() => {
          for (const img of Array.from(document.images)) img.loading = "eager";
        });
        await page.waitForFunction(() =>
          Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
        );
        // Chromium paints off-screen images only once decoded: scroll through once, decode, then go back to top.
        await page.evaluate(async () => {
          for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
          await Promise.all(
            Array.from(document.images).map((img) => img.decode().catch(() => undefined)),
          );
          window.scrollTo(0, 0);
        });
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(300);
        const path = `${OUT}/${locale}-${device}.png`;
        // Palette PNG: UI captures shrink 3-4x with no visible loss, which keeps the docs folder small.
        await sharp(await page.screenshot({ fullPage: true }))
          .png({ palette: true, quality: 90, effort: 7 })
          .toFile(path);
        console.info(`[landing] ${path}`);
        await context.close();
      }
    }
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
