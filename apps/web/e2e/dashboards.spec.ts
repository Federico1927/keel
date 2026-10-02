import { expect, test, type Browser, type Page } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

const NW = "/t/northwind-apparel";
const HB = "/t/harbor-home";
const KEY = "cpo_paid_social_e2e";
const SERIES_TITLE = "Ad spend vs contribution by week";
let homeEditUrl = "";

const digits = (s: string | null) => (s ?? "").replace(/[^0-9]/g, "");

async function as(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, email);
  return page;
}

test.describe("tenant dashboards (issue #43)", () => {
  test("the Northwind owner adds a weekly series and a filtered custom metric, publishes; operations sees them with the same value", async ({ page, browser }) => {
    page.on("dialog", (d) => d.accept());
    await login(page, "owner@northwind.demo");

    // custom metric: contribution / orders over paid-social orders, validated and previewed before saving
    await page.goto(`${NW}/dashboards/metrics`);
    const builder = page.getByTestId("metric-builder");
    await builder.locator("#m-label").fill("Contribution per paid-social order");
    await builder.locator("#m-key").fill(KEY);
    await builder.locator("#m-formula").fill("contribution / ord");
    await builder.getByTestId("formula-suggestions").getByRole("button", { name: "orders" }).click();
    await expect(builder.locator("#m-formula")).toHaveValue("contribution / orders ");
    await builder.locator("#f-channel").selectOption(["paid_social"]);
    await builder.locator("#m-format").selectOption("money");
    await builder.getByTestId("metric-preview").click();
    await expect(builder.getByTestId("metric-preview-value")).toBeVisible();
    await builder.getByTestId("metric-save").click();
    const row = page.getByTestId(`custom-metric-${KEY}`);
    await expect(row).toBeVisible();
    const metricValue = digits(await row.getByTestId("custom-metric-value").textContent());
    expect(metricValue.length).toBeGreaterThan(0);

    // the home editor: start from Keel's template, add the series and the KPI, publish
    await page.goto(NW);
    await page.getByTestId("edit-home").click();
    await expect(page.getByTestId("dashboard-editor")).toBeVisible();
    homeEditUrl = new URL(page.url()).pathname;
    await page.getByTestId("editor-reset-template").click();
    await expect(page.getByTestId("editor-widget")).toHaveCount(6);
    // COD is active on Northwind: its widget is in the catalog
    await expect(page.getByTestId("add-widget-cod_queue")).toBeVisible();

    await page.getByTestId("add-widget-timeseries").click();
    const settings = page.getByTestId("widget-settings");
    await settings.locator("select[id$='-metrics.0']").selectOption("ad_spend");
    await settings.locator("select[id$='-metrics.1']").selectOption("contribution");
    await settings.locator("select[id$='-granularity']").selectOption("week");
    await settings.locator("select[id$='-chart']").selectOption("bar");
    await settings.locator("input[id$='-title']").fill(SERIES_TITLE);
    await page.getByTestId("editor-done").click();

    await page.getByTestId("add-widget-kpi").click();
    await settings.locator("select[id$='-metric']").selectOption(`custom:${KEY}`);
    await settings.locator("select[id$='-period']").selectOption("mtd");
    await page.getByTestId("editor-done").click();
    await expect(page.getByTestId("editor-widget")).toHaveCount(8);

    // a draft is not visible to the team until published; preview as operations shows it
    await page.getByTestId("editor-save-draft").click();
    await expect(page.getByTestId("editor-message")).toBeVisible();
    await page.getByTestId("editor-preview-as").selectOption("operations");
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await expect(page.getByText(SERIES_TITLE)).toBeVisible();
    await page.goto(homeEditUrl);
    await page.getByTestId("editor-publish").click();
    await page.waitForURL(new RegExp(`${NW}$`));
    await expect(page.getByText(SERIES_TITLE)).toBeVisible();
    await expect(page.getByTestId("widget-timeseries").getByTestId("metric-chart")).toBeVisible();

    // operations sees the published home; the KPI equals the metric computed on the metrics page (same month)
    const ops = await as(browser, "ops@northwind.demo");
    await ops.goto(NW);
    await expect(ops.getByText(SERIES_TITLE)).toBeVisible();
    const kpi = ops.getByTestId(`kpi-custom:${KEY}`);
    await expect(kpi).toBeVisible();
    expect(digits(await kpi.getByTestId("kpi-value").textContent())).toBe(metricValue);
    // every number clicks through: the filtered metric opens the paid-social orders
    await kpi.click();
    await expect(ops).toHaveURL(/\/orders\?.*attrChannel=paid_social/);
    // Keel's tiles are still there
    await ops.goto(NW);
    await expect(ops.getByTestId("stock-tile")).toBeVisible();
    await expect(ops.getByTestId("forecast-card")).toBeVisible();
  });

  test("the marketing home variant is shown to marketing users only", async ({ browser }) => {
    const mk = await as(browser, "marketing@northwind.demo");
    await mk.goto(NW);
    await expect(mk.getByTestId("kpi-meta_roas")).toBeVisible();
    await expect(mk.getByTestId("widget-top-list")).toBeVisible();
    await expect(mk.getByText(SERIES_TITLE)).toHaveCount(0);
    const ops = await as(browser, "ops@northwind.demo");
    await ops.goto(NW);
    await expect(ops.getByTestId("dashboard-grid")).toBeVisible();
    await expect(ops.getByTestId("kpi-meta_roas")).toHaveCount(0);
    // the owner previews the home as marketing
    const owner = await as(browser, "owner@northwind.demo");
    await owner.goto(`${NW}?as=marketing`);
    await expect(owner.getByTestId("preview-banner")).toBeVisible();
    await expect(owner.getByTestId("kpi-meta_roas")).toBeVisible();
  });

  test("a viewer cannot edit: no edit controls and the editor and metrics pages are not reachable", async ({ page }) => {
    await login(page, "viewer@northwind.demo");
    await page.goto(NW);
    await expect(page.getByTestId("dashboard-grid")).toBeVisible();
    await expect(page.getByTestId("edit-home")).toHaveCount(0);
    await expect(page.getByTestId("customise-home")).toHaveCount(0);
    expect(homeEditUrl).toMatch(/\/dashboards\/[0-9a-f-]{36}\/edit$/);
    const editor = await page.goto(homeEditUrl);
    expect(editor?.status()).toBe(404);
    const metrics = await page.goto(`${NW}/dashboards/metrics`);
    expect(metrics?.status()).toBe(404);
  });

  test("Harbor Home keeps Keel's template, and without addon.cod the COD widget is never offered", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    await page.goto(HB);
    const grid = page.getByTestId("dashboard-grid");
    await expect(grid.locator("[data-widget]")).toHaveCount(6);
    await expect(page.getByTestId("stock-tile")).toBeVisible();
    await expect(page.getByTestId("forecast-card")).toBeVisible();
    await expect(page.getByTestId("customise-home")).toBeVisible();
    await page.goto(`${HB}/dashboards`);
    await expect(page.getByTestId("template-badge")).toBeVisible();
    // a personal copy opens the editor's catalog without touching the tenant home
    await page.getByTestId("duplicate-dashboard").first().click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
    await page.getByTestId("edit-dashboard").click();
    await expect(page.getByTestId("widget-catalog")).toBeVisible();
    await expect(page.getByTestId("add-widget-queue_review")).toBeVisible();
    await expect(page.getByTestId("add-widget-cod_queue")).toHaveCount(0);
    await page.goto(HB);
    await expect(page.getByTestId("dashboard-grid").locator("[data-widget]")).toHaveCount(6);
  });
});
