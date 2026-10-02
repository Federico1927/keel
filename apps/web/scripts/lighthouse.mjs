/**
 * Lighthouse mobile audit of the pages a phone user opens most (#49 §4 quality gates): dashboard,
 * orders list and an order detail at Northwind, signed in as the owner. Lighthouse runs with its
 * default mobile profile (Moto G Power viewport, simulated slow 4G and 4x CPU slowdown) against a
 * production server; the session cookie comes from a Playwright sign-in and goes with every request.
 *
 * Usage (production server with the demo seed loaded; `pnpm --filter @hullwise/web build` first):
 *   E2E_BASE_URL=http://localhost:3000 pnpm --filter @hullwise/web lighthouse
 *   MIN_PERFORMANCE=85 MIN_ACCESSIBILITY=95 RUNS=3 PAGES=dashboard,orders pnpm --filter @hullwise/web lighthouse
 *
 * The Lighthouse CLI is fetched with `npx` on first use (pinned version, not a project dependency).
 * Each page runs RUNS times (default 1) and keeps the median performance score; the JSON reports and a
 * summary go to LIGHTHOUSE_DIR (default: the system temp dir). Exits 1 when a page is under a threshold.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OUT = resolve(process.env.LIGHTHOUSE_DIR ?? join(tmpdir(), "hullwise-lighthouse"));
const LIGHTHOUSE = process.env.LIGHTHOUSE_VERSION ?? "13.5.0";
const MIN_PERFORMANCE = Number(process.env.MIN_PERFORMANCE ?? 85);
const MIN_ACCESSIBILITY = Number(process.env.MIN_ACCESSIBILITY ?? 95);
const RUNS = Math.max(1, Number(process.env.RUNS ?? 1));
const PASSWORD = process.env.DEMO_PASSWORD ?? "hullwise-demo-2026";
const EMAIL = process.env.LIGHTHOUSE_USER ?? "owner@northwind.demo";
const T = "/t/northwind-apparel";
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const ONLY = new Set((process.env.PAGES ?? "").split(",").filter(Boolean));

const PAGES = [
  { name: "dashboard", path: T },
  { name: "orders", path: `${T}/orders` },
  { name: "order-detail", list: `${T}/orders?status=shipped`, match: /\/orders\/[0-9a-f-]{36}$/ },
].filter((p) => !ONLY.size || ONLY.has(p.name));

/** Signs in with Playwright and returns the Cookie header plus the resolved page URLs. */
async function session() {
  const browser = await chromium.launch(existsSync(chromiumPath) ? { executablePath: chromiumPath } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
  await page.waitForURL(/\/t\//);
  const urls = [];
  for (const p of PAGES) {
    if (!p.list) { urls.push({ name: p.name, url: `${BASE}${p.path}` }); continue; }
    await page.goto(`${BASE}${p.list}`);
    const href = (await page.locator("main a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))).find((h) => p.match.test(h.split("?")[0]));
    if (!href) throw new Error(`no link for ${p.name} on ${p.list}`);
    urls.push({ name: p.name, url: `${BASE}${href}` });
  }
  const cookies = (await context.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
  await browser.close();
  return { cookies, urls };
}

function runLighthouse(url, headersFile, out) {
  const args = [
    "--yes", `lighthouse@${LIGHTHOUSE}`, url,
    "--quiet", "--output=json", `--output-path=${out}`,
    "--only-categories=performance,accessibility",
    `--extra-headers=${headersFile}`,
    "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --no-proxy-server",
  ];
  execFileSync("npx", args, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CHROME_PATH: existsSync(chromiumPath) ? chromiumPath : process.env.CHROME_PATH } });
  return JSON.parse(readFileSync(out, "utf8"));
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { cookies, urls } = await session();
  const headersFile = join(OUT, "headers.json");
  writeFileSync(headersFile, JSON.stringify({ Cookie: cookies }));
  const results = [];
  for (const { name, url } of urls) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(runLighthouse(url, headersFile, join(OUT, `${name}-${i + 1}.json`)));
    const perf = runs.map((r) => Math.round((r.categories.performance.score ?? 0) * 100));
    const a11y = runs.map((r) => Math.round((r.categories.accessibility.score ?? 0) * 100));
    const best = runs[perf.indexOf(median(perf))];
    const metric = (id) => best.audits[id]?.displayValue ?? "—";
    const failing = Object.values(best.audits).filter((a) => a.score !== null && a.score < 1 && best.categories.accessibility.auditRefs.some((r) => r.id === a.id && r.weight > 0)).map((a) => `${a.id}: ${a.title}`);
    results.push({ name, url: url.replace(BASE, ""), performance: median(perf), accessibility: Math.min(...a11y), runs: perf, lcp: metric("largest-contentful-paint"), tbt: metric("total-blocking-time"), cls: metric("cumulative-layout-shift"), fcp: metric("first-contentful-paint"), failing });
  }
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ base: BASE, lighthouse: LIGHTHOUSE, at: new Date().toISOString(), results }, null, 2));
  console.info(`\nLighthouse ${LIGHTHOUSE}, mobile profile, ${RUNS} run(s) per page (median performance) — reports in ${OUT}`);
  console.table(results.map(({ name, performance, accessibility, fcp, lcp, tbt, cls }) => ({ name, performance, accessibility, fcp, lcp, tbt, cls })));
  for (const r of results) if (r.failing.length) console.info(`${r.name} accessibility audits to fix:\n  ${r.failing.join("\n  ")}`);
  const under = results.filter((r) => r.performance < MIN_PERFORMANCE || r.accessibility < MIN_ACCESSIBILITY);
  if (under.length) {
    console.error(`Under the thresholds (performance ≥ ${MIN_PERFORMANCE}, accessibility ≥ ${MIN_ACCESSIBILITY}): ${under.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
