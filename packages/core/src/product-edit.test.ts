import { describe, expect, it } from "vitest";
import { sanitizeProductHtml, htmlToText, isStaleEdit, normalizeTags, parseTagInput, planProductPatch, planVariantPatch, seoPreview, shopifyAdminProductUrl, validateProductEdit, validateVariantEdit, type EditableProduct, type EditableVariant } from "./product-edit";

const product: EditableProduct = { title: "Giacca", descriptionHtml: "<p>Calda</p>", vendor: "NW", productType: "Outerwear", tags: ["new", "Core"], status: "active", seoTitle: null, seoDescription: null, categoryId: null };
const variant: EditableVariant = { priceMinor: 12900, compareAtMinor: null, sku: "GIA-M", barcode: null, weightGrams: 800, inventoryPolicy: null };

describe("product edit planning", () => {
  it("keeps only the fields that change, trimmed", () => {
    expect(planProductPatch(product, { title: " Giacca ", vendor: "NW", tags: ["new", " Core", "core"], status: "active" })).toEqual({});
    expect(planProductPatch(product, { title: "Giacca Light", tags: ["new", "Core", "sale"], status: "draft", seoTitle: " SEO ", categoryId: "gid://shopify/TaxonomyCategory/aa-1" })).toEqual({ title: "Giacca Light", tags: ["new", "Core", "sale"], status: "draft", seo: { title: "SEO", description: null }, categoryId: "gid://shopify/TaxonomyCategory/aa-1" });
    // clearing a field writes an empty value, never undefined
    expect(planProductPatch(product, { vendor: " ", descriptionHtml: null })).toEqual({ vendor: "", descriptionHtml: "" });
    // the SEO pair is written together, keeping the other half
    expect(planProductPatch({ ...product, seoTitle: "T" }, { seoDescription: "D" })).toEqual({ seo: { title: "T", description: "D" } });
  });
  it("plans variant changes", () => {
    expect(planVariantPatch(variant, { priceMinor: 12900, sku: " GIA-M ", inventoryPolicy: "deny" })).toEqual({});
    expect(planVariantPatch(variant, { priceMinor: 9900, compareAtMinor: 12900, sku: "", barcode: "800", weightGrams: null, inventoryPolicy: "continue" })).toEqual({ priceMinor: 9900, compareAtMinor: 12900, sku: null, barcode: "800", weightGrams: null, inventoryPolicy: "continue" });
  });
  it("validates", () => {
    expect(validateProductEdit({ title: "  " })).toBe("title_required");
    expect(validateProductEdit({ seoTitle: "x".repeat(71) })).toBe("too_long");
    expect(validateProductEdit({ status: "deleted" as never })).toBe("invalid_status");
    expect(validateProductEdit({ title: "ok", tags: ["a"] })).toBeNull();
    expect(validateVariantEdit({ priceMinor: -1 })).toBe("invalid_price");
    expect(validateVariantEdit({ compareAtMinor: 1.5 })).toBe("invalid_price");
    expect(validateVariantEdit({ weightGrams: -3 })).toBe("invalid_weight");
    expect(validateVariantEdit({ priceMinor: 0, compareAtMinor: null, weightGrams: null })).toBeNull();
  });
  it("normalizes tags", () => {
    expect(normalizeTags([" a", "A", "", "b "])).toEqual(["a", "b"]);
    expect(parseTagInput("summer, Sale , ,summer")).toEqual(["summer", "Sale"]);
  });
});

describe("stale edits", () => {
  it("refuses an edit opened before the platform's last change", () => {
    const opened = new Date("2026-09-20T08:15:00Z");
    expect(isStaleEdit(new Date("2026-09-20T08:15:00Z"), opened)).toBe(false);
    expect(isStaleEdit(new Date("2026-09-20T08:15:01Z"), opened)).toBe(true);
    expect(isStaleEdit(null, opened)).toBe(false);
    expect(isStaleEdit(new Date(), null)).toBe(false);
  });
});

describe("SEO preview and admin link", () => {
  it("falls back to title and description text, clipped like a search result", () => {
    expect(htmlToText("<p>Calda &amp; <strong>leggera</strong></p><script>x()</script><ul><li>A</li><li>B</li></ul>")).toBe("Calda & leggera A B");
    const p = seoPreview({ title: "Giacca", handle: "giacca", seoTitle: null, seoDescription: null, descriptionHtml: `<p>${"parola ".repeat(40)}</p>` }, "northwind-demo.myshopify.com");
    expect(p.title).toBe("Giacca");
    expect(p.description.length).toBe(160);
    expect(p.description.endsWith("…")).toBe(true);
    expect(p.url).toBe("https://northwind-demo.myshopify.com/products/giacca");
    expect(seoPreview({ title: "G", handle: "g", seoTitle: "SEO title", seoDescription: "SEO text", descriptionHtml: null }, null)).toEqual({ title: "SEO title", description: "SEO text", url: "/products/g" });
  });
  it("builds the Shopify admin deep link", () => {
    expect(shopifyAdminProductUrl("northwind-demo.myshopify.com", "8100001")).toBe("https://admin.shopify.com/store/northwind-demo/products/8100001");
    expect(shopifyAdminProductUrl(null, "1")).toBeNull();
    expect(shopifyAdminProductUrl("evil.com/x?y", "1")).toBeNull();
  });
});

describe("description rendering", () => {
  it("keeps formatting and drops anything executable", () => {
    expect(sanitizeProductHtml('<p class="x" onclick="alert(1)">Ciao <strong>mondo</strong></p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><a href="https://shop.example/a">y</a><!-- c --><iframe src="https://evil"></iframe>')).toBe('<p>Ciao <strong>mondo</strong></p><a>x</a><a href="https://shop.example/a" target="_blank" rel="noopener noreferrer nofollow">y</a>');
    expect(sanitizeProductHtml("a < b > c<br/>")).toBe("a &lt; b &gt; c<br>");
    expect(sanitizeProductHtml('<a href="https://x.example/?q=" onmouseover="1">z</a>')).toBe('<a href="https://x.example/?q=" target="_blank" rel="noopener noreferrer nofollow">z</a>');
    expect(sanitizeProductHtml("<a href='https://x.example/\"><script>'>z</a>")).toBe("<a>'&gt;z</a>");
    expect(sanitizeProductHtml(null)).toBe("");
  });
});
