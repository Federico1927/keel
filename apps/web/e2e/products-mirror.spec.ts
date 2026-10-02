import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/** Issue #19: images everywhere, the full Shopify mirror on the product page, two-way edits, sync. */
const T = "/t/northwind-apparel";
const stamp = () => Date.now().toString().slice(-6);

async function openProduct(page: Page, row: number): Promise<string> {
  await page.goto(`${T}/products?page=2`);
  await page.locator("table tbody tr").nth(row).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  return page.url();
}

test.describe("products: images, Shopify mirror, two-way sync", () => {
  test("every product in the list has an image served by the app, and the catalog syncs from Shopify", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/products`);
    const rows = page.locator("table tbody tr");
    const n = await rows.count();
    expect(n).toBeGreaterThan(5);
    for (let i = 0; i < n; i++) await expect(rows.nth(i).locator("img").first()).toHaveAttribute("src", /^\/demo-media\/.+\.svg$/);
    const src = await rows.first().locator("img").first().getAttribute("src");
    const img = await page.request.get(src!);
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toContain("image/svg+xml");
    await page.getByTestId("sync-catalog-products").click();
    await expect(page.getByTestId("catalog-sync-result")).toHaveText(/Catalog synced|Catalogo sincronizzato|started in the background|avviata/, { timeout: 90_000 });
    await expect(page.getByTestId("catalog-last-synced")).toHaveText(/./);
    // thumbnails in the stock list too
    await page.goto(`${T}/inventory`);
    await expect(page.locator("table tbody tr").first().locator("img").first()).toHaveAttribute("src", /^\/demo-media\//);
  });

  test("the product page shows every mirrored field, the gallery with lightbox and the Keel panels", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await openProduct(page, 0);
    const gallery = page.getByTestId("product-gallery");
    await expect(gallery.getByTestId("gallery-item").first()).toBeVisible();
    expect(await gallery.getByTestId("gallery-item").count()).toBeGreaterThan(1);
    await gallery.getByTestId("gallery-item").first().locator("button").click();
    const lightbox = page.getByTestId("gallery-lightbox");
    await expect(lightbox.locator("img")).toBeVisible();
    const first = await lightbox.locator("img").getAttribute("src");
    await lightbox.getByTestId("lightbox-next").click();
    await expect(lightbox.locator("img")).not.toHaveAttribute("src", first!);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("product-description")).toBeVisible();
    await expect(page.getByTestId("product-status")).toContainText(/Online|Negozio online/);
    await expect(page.getByTestId("product-organisation")).toContainText(/Apparel & Accessories/);
    await expect(page.getByTestId("seo-preview")).toContainText("northwind-demo.myshopify.com/products/");
    await expect(page.getByTestId("product-metafields")).toContainText("custom.material");
    await expect(page.getByTestId("variant-row").first().locator("img")).toHaveAttribute("src", /^\/demo-media\//);
    await page.getByTestId("variant-fields").locator("summary").click();
    await expect(page.getByTestId("variant-fields")).toContainText(/Stop selling|Interrompi la vendita|Continue selling|Continua a vendere/);
    await expect(page.getByTestId("edit-in-shopify")).toHaveAttribute("href", /^https:\/\/admin\.shopify\.com\/store\/northwind-demo\/products\/\d+$/);
    // Keel's own panels stay
    await expect(page.getByText(/Variants and stock|Varianti e giacenze/)).toBeVisible();
    await expect(page.getByTestId("price-history")).toBeVisible();
    await expect(page.getByTestId("product-pnl")).toBeVisible();
    await expect(page.getByTestId("adjust-stock")).toBeVisible();
    await expect(page.getByTestId("product-last-synced")).toHaveText(/Shopify/);
  });

  test("title, tags, SEO, status and variant fields are written to Shopify and audited; media reorder too", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    const url = await openProduct(page, 1);
    const s = stamp();
    // title and description
    await page.getByTestId("product-details-edit").click();
    const title = `E2E product ${s}`;
    await page.getByTestId("edit-title").fill(title);
    await page.getByTestId("edit-description").fill(`<p>Described ${s}</p><script>alert(1)</script>`);
    await page.getByTestId("product-details").getByTestId("save-product").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByTestId("product-description")).toHaveText(`Described ${s}`);
    // tags
    await page.getByTestId("product-organisation-edit").click();
    const tags = page.getByTestId("edit-tags");
    await tags.fill(`${await tags.inputValue()}, e2e-${s}`);
    await page.getByTestId("product-organisation").getByTestId("save-product").click();
    await expect(page.getByTestId("product-tags")).toContainText(`e2e-${s}`);
    // SEO
    await page.getByTestId("product-seo-edit").click();
    await page.getByTestId("edit-seo-title").fill(`SEO ${s}`);
    await page.getByTestId("product-seo").getByTestId("save-product").click();
    await expect(page.getByTestId("seo-preview")).toContainText(`SEO ${s}`);
    // status
    await page.getByTestId("product-status-edit").click();
    await page.getByTestId("edit-status").selectOption("draft");
    await page.getByTestId("product-status").getByTestId("save-product").click();
    await expect(page.getByTestId("product-status-value")).toHaveText(/Draft|Bozza/);
    // variant price, compare-at and SKU
    await page.getByTestId("edit-variants").click();
    await page.getByTestId("edit-variant-price").first().fill("77.00");
    await page.getByTestId("edit-variant-compare").first().fill("99.00");
    await page.getByTestId("edit-variant-sku").first().fill(`E2E-${s}`);
    await page.getByTestId("variants-editor").getByTestId("save-product").click();
    await expect(page.getByTestId("variants-editor")).toHaveCount(0);
    const row = page.getByTestId("variant-row").filter({ hasText: `E2E-${s}` });
    await expect(row).toContainText(/77[.,]00/);
    await expect(row).toContainText(/99[.,]00/);
    // media reorder: the second image becomes the cover
    const items = page.getByTestId("product-gallery").getByTestId("gallery-item");
    const before = [await items.nth(0).locator("img").getAttribute("src"), await items.nth(1).locator("img").getAttribute("src")];
    await page.getByTestId("manage-media").click();
    await items.nth(0).getByTestId("media-move-right").click();
    await expect(items.nth(0).locator("img")).toHaveAttribute("src", before[1]!);
    await expect(items.nth(1).locator("img")).toHaveAttribute("src", before[0]!);
    // every write left an audit entry
    await page.goto(`${T}/audit?action=product.`);
    await expect(page.getByTestId("audit-row").filter({ hasText: "product.media_reorder" }).first()).toBeVisible();
    await expect(page.getByTestId("audit-row").filter({ hasText: "product.updated" }).first()).toBeVisible();
    // the integrations page lists the synchronous writes
    await page.goto(`${T}/integrations`);
    await expect(page.locator('[data-testid="platform-write-row"][data-kind="product.media"][data-status="succeeded"]').first()).toBeVisible();
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  });

  test("an edit opened before the product changed in Shopify is refused with a reload", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pa = await a.newPage();
    const pb = await b.newPage();
    await login(pa, "owner@northwind.demo");
    await login(pb, "admin@northwind.demo");
    const url = await openProduct(pa, 2);
    await pb.goto(url);
    // B changes the product (in Shopify, through Keel): A's page still holds the old version
    await pb.getByTestId("product-details-edit").click();
    await pb.getByTestId("edit-title").fill(`Changed by B ${stamp()}`);
    await pb.getByTestId("product-details").getByTestId("save-product").click();
    await expect(pb.getByTestId("edit-title")).toHaveCount(0);
    await pa.getByTestId("product-seo-edit").click();
    await pa.getByTestId("edit-seo-title").fill("Stale edit");
    await pa.getByTestId("product-seo").getByTestId("save-product").click();
    await expect(pa.getByTestId("stale-edit")).toBeVisible();
    await pa.getByTestId("stale-edit").getByRole("button").click();
    await expect(pa.getByRole("heading", { level: 1 })).toHaveText(/Changed by B/);
    await a.close();
    await b.close();
  });

  test("Sync from Shopify on the product page, and the page is usable on a phone", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.setViewportSize({ width: 390, height: 844 });
    await openProduct(page, 3);
    await page.getByTestId("sync-product").click();
    await expect(page.getByTestId("sync-product-result")).toHaveText(/up to date|aggiornat|updated/);
    await expect(page.getByTestId("product-gallery").getByTestId("gallery-item").first()).toBeVisible();
    // the product cards fit the phone width (wide tables scroll inside their card)
    for (const id of ["product-gallery", "product-details", "product-variants", "product-status", "product-organisation", "product-seo"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x + box!.width, id).toBeLessThanOrEqual(391);
    }
  });
});
