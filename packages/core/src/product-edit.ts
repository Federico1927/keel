/**
 * Product editing rules (issue #19): Keel mirrors every platform field on read and edits a defined
 * subset. Pure: what changed, whether the edit is still based on the platform's current version,
 * the SEO preview and the deep link for the fields edited on the platform.
 */

export type ProductStatusValue = "active" | "draft" | "archived";
export type InventoryPolicy = "deny" | "continue";

/** The product fields Keel edits; everything else is "Edit in Shopify". */
export interface EditableProduct {
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: ProductStatusValue;
  seoTitle: string | null;
  seoDescription: string | null;
  categoryId: string | null;
}
export interface EditableVariant {
  priceMinor: number;
  compareAtMinor: number | null;
  sku: string | null;
  barcode: string | null;
  weightGrams: number | null;
  inventoryPolicy: InventoryPolicy | null;
}

/** Structurally the integrations `ProductPatch`: only the fields that change. */
export interface PlannedProductPatch {
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: ProductStatusValue;
  seo?: { title: string | null; description: string | null };
  categoryId?: string | null;
}
export type PlannedVariantPatch = Partial<Omit<EditableVariant, "inventoryPolicy">> & { inventoryPolicy?: InventoryPolicy };

export const PRODUCT_EDIT_LIMITS = { title: 255, text: 255, seoTitle: 70, seoDescription: 320, description: 60_000, tag: 255, tags: 250 } as const;

export type ProductEditError = "title_required" | "too_long" | "invalid_price" | "invalid_weight" | "invalid_status";

const trimOrNull = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** Tags as the platform keeps them: trimmed, no empties, no case-insensitive duplicates, order kept. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** "a, b , c" → ["a", "b", "c"] (the tags input of the edit form). */
export function parseTagInput(text: string): string[] {
  return normalizeTags(text.split(","));
}

export function validateProductEdit(p: Partial<EditableProduct>): ProductEditError | null {
  if (p.title !== undefined && !p.title.trim()) return "title_required";
  if (p.title !== undefined && p.title.trim().length > PRODUCT_EDIT_LIMITS.title) return "too_long";
  for (const v of [p.vendor, p.productType]) if (v && v.trim().length > PRODUCT_EDIT_LIMITS.text) return "too_long";
  if (p.seoTitle && p.seoTitle.trim().length > PRODUCT_EDIT_LIMITS.seoTitle) return "too_long";
  if (p.seoDescription && p.seoDescription.trim().length > PRODUCT_EDIT_LIMITS.seoDescription) return "too_long";
  if (p.descriptionHtml && p.descriptionHtml.length > PRODUCT_EDIT_LIMITS.description) return "too_long";
  if (p.tags && (p.tags.length > PRODUCT_EDIT_LIMITS.tags || p.tags.some((t) => t.length > PRODUCT_EDIT_LIMITS.tag))) return "too_long";
  if (p.status !== undefined && !["active", "draft", "archived"].includes(p.status)) return "invalid_status";
  return null;
}

export function validateVariantEdit(v: Partial<EditableVariant>): ProductEditError | null {
  if (v.priceMinor !== undefined && (!Number.isInteger(v.priceMinor) || v.priceMinor < 0)) return "invalid_price";
  if (v.compareAtMinor !== undefined && v.compareAtMinor !== null && (!Number.isInteger(v.compareAtMinor) || v.compareAtMinor < 0)) return "invalid_price";
  if (v.weightGrams !== undefined && v.weightGrams !== null && (!Number.isInteger(v.weightGrams) || v.weightGrams < 0)) return "invalid_weight";
  for (const s of [v.sku, v.barcode]) if (s && s.trim().length > PRODUCT_EDIT_LIMITS.text) return "too_long";
  return null;
}

/** The product fields that really change (trimmed); empty object = nothing to write. */
export function planProductPatch(current: EditableProduct, requested: Partial<EditableProduct>): PlannedProductPatch {
  const out: PlannedProductPatch = {};
  if (requested.title !== undefined && requested.title.trim() !== current.title) out.title = requested.title.trim();
  if (requested.descriptionHtml !== undefined && (requested.descriptionHtml ?? "") !== (current.descriptionHtml ?? "")) out.descriptionHtml = requested.descriptionHtml ?? "";
  if (requested.vendor !== undefined && trimOrNull(requested.vendor) !== trimOrNull(current.vendor)) out.vendor = trimOrNull(requested.vendor) ?? "";
  if (requested.productType !== undefined && trimOrNull(requested.productType) !== trimOrNull(current.productType)) out.productType = trimOrNull(requested.productType) ?? "";
  if (requested.tags !== undefined) {
    const next = normalizeTags(requested.tags);
    if (JSON.stringify(next) !== JSON.stringify(normalizeTags(current.tags))) out.tags = next;
  }
  if (requested.status !== undefined && requested.status !== current.status) out.status = requested.status;
  const seoTitle = requested.seoTitle !== undefined ? trimOrNull(requested.seoTitle) : trimOrNull(current.seoTitle);
  const seoDescription = requested.seoDescription !== undefined ? trimOrNull(requested.seoDescription) : trimOrNull(current.seoDescription);
  if (seoTitle !== trimOrNull(current.seoTitle) || seoDescription !== trimOrNull(current.seoDescription)) out.seo = { title: seoTitle, description: seoDescription };
  if (requested.categoryId !== undefined && trimOrNull(requested.categoryId) !== trimOrNull(current.categoryId)) out.categoryId = trimOrNull(requested.categoryId);
  return out;
}

export function planVariantPatch(current: EditableVariant, requested: Partial<EditableVariant>): PlannedVariantPatch {
  const out: PlannedVariantPatch = {};
  if (requested.priceMinor !== undefined && requested.priceMinor !== current.priceMinor) out.priceMinor = requested.priceMinor;
  if (requested.compareAtMinor !== undefined && requested.compareAtMinor !== current.compareAtMinor) out.compareAtMinor = requested.compareAtMinor;
  if (requested.sku !== undefined && trimOrNull(requested.sku) !== trimOrNull(current.sku)) out.sku = trimOrNull(requested.sku);
  if (requested.barcode !== undefined && trimOrNull(requested.barcode) !== trimOrNull(current.barcode)) out.barcode = trimOrNull(requested.barcode);
  if (requested.weightGrams !== undefined && requested.weightGrams !== current.weightGrams) out.weightGrams = requested.weightGrams;
  if (requested.inventoryPolicy && requested.inventoryPolicy !== (current.inventoryPolicy ?? "deny")) out.inventoryPolicy = requested.inventoryPolicy;
  return out;
}

/**
 * An edit is stale when the platform changed the product after the version the user opened.
 * Without a known opened version nothing can be compared, so the edit goes through.
 */
export function isStaleEdit(platformUpdatedAt: Date | null | undefined, openedVersion: Date | null | undefined): boolean {
  if (!platformUpdatedAt || !openedVersion) return false;
  return platformUpdatedAt.getTime() > openedVersion.getTime();
}

/** Plain text of a product description (SEO fallback, previews). */
export function htmlToText(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** What a search engine shows, as the platform builds it: SEO fields, else the title and the description text. */
export function seoPreview(p: { title: string; handle: string | null; seoTitle: string | null; seoDescription: string | null; descriptionHtml: string | null }, storeHost: string | null): { title: string; description: string; url: string } {
  const title = clip(trimOrNull(p.seoTitle) ?? p.title, 70);
  const description = clip(trimOrNull(p.seoDescription) ?? htmlToText(p.descriptionHtml), 160);
  const host = (storeHost ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return { title, description, url: `${host ? `https://${host}` : ""}/products/${p.handle ?? ""}` };
}

/** Where the merchant edits the fields Keel does not: the product page of the Shopify admin. */
export function shopifyAdminProductUrl(shopDomain: string | null | undefined, productExternalId: string | null | undefined): string | null {
  if (!shopDomain || !productExternalId) return null;
  const store = shopDomain.replace(/^https?:\/\//, "").replace(/\.myshopify\.com\/?$/i, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(store)) return null;
  return `https://admin.shopify.com/store/${store}/products/${encodeURIComponent(productExternalId)}`;
}

const SAFE_TAGS = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "span", "a", "table", "thead", "tbody", "tr", "th", "td", "hr"]);
const VOID_TAGS = new Set(["br", "hr"]);

/**
 * A product description from the platform rendered inside Keel: only formatting tags survive, with
 * no attributes except an http(s) `href` on links (opened in a new tab). Scripts, styles, iframes,
 * event handlers, comments and every other tag are dropped.
 */
export function sanitizeProductHtml(html: string | null | undefined): string {
  const src = (html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|textarea|select)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|textarea|select)\b[^>]*>/gi, "");
  return src.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<|>/g, (m: string, name: string | undefined, attrs: string | undefined) => {
    if (!name) return m === "<" ? "&lt;" : "&gt;";
    const tag = name.toLowerCase();
    if (!SAFE_TAGS.has(tag)) return "";
    if (m.startsWith("</")) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
    if (tag === "a") {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs ?? "");
      const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
      return /^https?:\/\//i.test(url) ? `<a href="${url.replace(/"/g, "&quot;").replace(/</g, "&lt;")}" target="_blank" rel="noopener noreferrer nofollow">` : "<a>";
    }
    return `<${tag}>`;
  });
}
