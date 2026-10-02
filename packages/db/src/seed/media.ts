import { createHash } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

/**
 * Demo product gallery and Shopify field mirror (issue #19). Every demo product gets placeholder
 * images served by the app (`/demo-media/...svg`, generated SVG: no external CDN), one per value of
 * its last option (the visual one in the demo catalog: colour, finish) plus a detail shot, and
 * every variant points at the image of its value. Description, SEO, category, collections,
 * channels, metafields and variant fields are filled where empty. Deterministic (hashes, no rng),
 * idempotent (only missing rows and empty fields), shared by the full seed and the production
 * settings step (`db:seed:settings`), so a hosted demo gets it without a reseed.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type DemoCatalogKey = "northwind" | "harbor";

/** The placeholder route of the web app (`apps/web/src/app/demo-media/[...path]`). */
export const DEMO_MEDIA_PREFIX = "/demo-media";
/** Image URLs written by earlier seeds, pointing at a CDN that never existed: replaced. */
const LEGACY_IMAGE_PREFIX = "https://cdn.hullwise.example/";
const MAX_VALUE_IMAGES = 6;

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
const hash = (s: string) => createHash("sha256").update(s).digest();
/** A stable uuid (v4 layout) from a key, so reseeds write the same media ids. */
export function stableUuid(key: string): string {
  const b = hash(key);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const pick = <T>(xs: readonly T[], key: string): T => xs[hash(key).readUInt32BE(0) % xs.length]!;

export function demoMediaUrl(handle: string, position: number, label: string): string {
  return `${DEMO_MEDIA_PREFIX}/${slug(handle)}/${position + 1}-${slug(label)}.svg`;
}

interface CategoryRef { id: string; name: string }
/** Demo catalog → Shopify Standard Product Taxonomy (ids as Shopify writes them; names abridged). */
const CATEGORIES: Record<string, CategoryRef> = {
  Outerwear: { id: "gid://shopify/TaxonomyCategory/aa-1-10", name: "Apparel & Accessories > Clothing > Outerwear" },
  Womenswear: { id: "gid://shopify/TaxonomyCategory/aa-1-4", name: "Apparel & Accessories > Clothing > Dresses" },
  Essentials: { id: "gid://shopify/TaxonomyCategory/aa-1-13", name: "Apparel & Accessories > Clothing > Clothing Tops" },
  Accessories: { id: "gid://shopify/TaxonomyCategory/aa-2", name: "Apparel & Accessories > Clothing Accessories" },
  "Furniture & Lighting": { id: "gid://shopify/TaxonomyCategory/fr-2", name: "Furniture > Tables" },
  Textiles: { id: "gid://shopify/TaxonomyCategory/hg-12", name: "Home & Garden > Linens & Bedding" },
  Decor: { id: "gid://shopify/TaxonomyCategory/hg-3", name: "Home & Garden > Decor" },
};
const HS_CODES: Record<string, string> = { Outerwear: "620193", Womenswear: "620442", Essentials: "610910", Accessories: "621420", "Furniture & Lighting": "940360", Textiles: "630231", Decor: "691390" };

function describe(key: DemoCatalogKey, p: { title: string; productType: string | null; vendor: string | null }, options: { name: string; values: string[] }[]): string {
  const opts = options.map((o) => `${o.name}: ${o.values.join(", ")}`).join(" · ");
  if (key === "northwind")
    return `<p><strong>${p.title}</strong> di ${p.vendor ?? "Northwind"}: un capo ${p.productType === "Outerwear" ? "da mezza stagione, caldo e leggero" : "essenziale da indossare ogni giorno"}.</p><ul><li>Tessuto selezionato in Europa</li><li>Vestibilità regolare</li><li>${opts}</li></ul><p>Lavare a 30°, non usare l'asciugatrice.</p>`;
  return `<p><strong>${p.title}</strong> by ${p.vendor ?? "Harbor Home"}, made to last in a busy home.</p><ul><li>Hand-finished details</li><li>${opts}</li></ul><p>Wipe clean with a soft, dry cloth.</p>`;
}

export interface DemoCatalogReport {
  media: number;
  products: number;
  variants: number;
}

/** Fills the gallery and the mirror fields of the demo tenant's products where missing. */
export async function ensureDemoProductCatalog(db: Db, tenantId: string, key: DemoCatalogKey, now = new Date()): Promise<DemoCatalogReport> {
  const out: DemoCatalogReport = { media: 0, products: 0, variants: 0 };
  const products = await db.select().from(schema.products).where(eq(schema.products.tenantId, tenantId)).orderBy(asc(schema.products.title));
  if (!products.length) return out;
  const withMedia = new Set((await db.selectDistinct({ id: schema.productMedia.productId }).from(schema.productMedia).where(eq(schema.productMedia.tenantId, tenantId))).map((r) => r.id));
  const shop = key === "northwind" ? "Negozio online" : "Online Store";
  for (const [i, p] of products.entries()) {
    const options = (p.options as { name: string; values: string[] }[] | null) ?? [];
    const visual = options.at(-1) ?? null;
    const handle = p.handle ?? slug(p.title);
    if (!withMedia.has(p.id)) {
      const values = (visual?.values ?? []).slice(0, MAX_VALUE_IMAGES);
      const labels = [...(values.length ? values : [p.productType ?? p.title]), "detail"];
      const rows = labels.map((label, position) => ({
        id: stableUuid(`${tenantId}:${p.id}:media:${position}`),
        tenantId,
        productId: p.id,
        externalId: p.externalId ? `gid://shopify/MediaImage/${p.externalId}${String(position + 1).padStart(2, "0")}` : null,
        type: "image",
        url: demoMediaUrl(handle, position, label),
        alt: label === "detail" ? `${p.title} – ${key === "northwind" ? "dettaglio" : "detail"}` : `${p.title} – ${label}`,
        position,
        width: 1200,
        height: 1500,
        createdAt: now,
        updatedAt: now,
      }));
      await db.insert(schema.productMedia).values(rows).onConflictDoNothing();
      out.media += rows.length;
      if (!p.imageUrl || p.imageUrl.startsWith(LEGACY_IMAGE_PREFIX)) await db.update(schema.products).set({ imageUrl: rows[0]!.url }).where(eq(schema.products.id, p.id));
      // each variant shows the image of its visual value (the first image when there is none)
      if (visual && values.length) {
        for (const [position, value] of values.entries()) {
          const r = await db.update(schema.productVariants).set({ imageMediaId: rows[position]!.id }).where(and(eq(schema.productVariants.productId, p.id), isNull(schema.productVariants.imageMediaId), sql`${schema.productVariants.optionValues}->>${visual.name} = ${value}`)).returning({ id: schema.productVariants.id });
          out.variants += r.length;
        }
      }
      const rest = await db.update(schema.productVariants).set({ imageMediaId: rows[0]!.id }).where(and(eq(schema.productVariants.productId, p.id), isNull(schema.productVariants.imageMediaId))).returning({ id: schema.productVariants.id });
      out.variants += rest.length;
    } else if (p.imageUrl?.startsWith(LEGACY_IMAGE_PREFIX) || !p.imageUrl) {
      const [cover] = await db.select({ url: schema.productMedia.url }).from(schema.productMedia).where(eq(schema.productMedia.productId, p.id)).orderBy(asc(schema.productMedia.position)).limit(1);
      if (cover) await db.update(schema.products).set({ imageUrl: cover.url }).where(eq(schema.products.id, p.id));
    }

    // the rest of the Shopify mirror, only where Hullwise holds nothing yet
    const category = CATEGORIES[p.productType ?? ""] ?? null;
    const fill: Partial<typeof schema.products.$inferInsert> = {};
    if (p.descriptionHtml === null) fill.descriptionHtml = describe(key, p, options);
    if (p.seoTitle === null && p.seoDescription === null && i % 3 === 0) Object.assign(fill, { seoTitle: `${p.title} | ${p.vendor ?? ""}`.slice(0, 70), seoDescription: key === "northwind" ? `${p.title}: spedizione in 24/48 ore e reso gratuito entro 30 giorni.` : `${p.title}: free shipping over $75 and 60-day returns.` });
    if (p.categoryId === null && category) Object.assign(fill, { categoryId: category.id, categoryName: category.name });
    if (p.collections === null) fill.collections = [...(p.productType ? [{ id: `gid://shopify/Collection/${stableUuid(`${tenantId}:col:${p.productType}`).slice(0, 8)}`, title: p.productType, handle: slug(p.productType) }] : []), ...(p.tags.includes("new") ? [{ id: `gid://shopify/Collection/${stableUuid(`${tenantId}:col:new`).slice(0, 8)}`, title: key === "northwind" ? "Nuovi arrivi" : "New arrivals", handle: "new" }] : [])];
    if (p.publishedChannels === null) fill.publishedChannels = [{ id: "gid://shopify/Publication/1", name: shop, published: p.status === "active", publishedAt: p.status === "active" ? (p.platformCreatedAt ?? now).toISOString() : null }, { id: "gid://shopify/Publication/2", name: "Point of Sale", published: p.status === "active" && i % 4 !== 0, publishedAt: p.status === "active" && i % 4 !== 0 ? (p.platformCreatedAt ?? now).toISOString() : null }, ...(key === "northwind" ? [{ id: "gid://shopify/Publication/3", name: "Facebook & Instagram", published: p.status === "active" && i % 2 === 0, publishedAt: null }] : [])];
    if (p.metafields === null) fill.metafields = key === "northwind" ? [{ namespace: "custom", key: "material", type: "single_line_text_field", value: pick(["Cotone biologico", "Lana merino", "Lino", "Nylon riciclato", "Viscosa"], p.id) }, { namespace: "custom", key: "care", type: "multi_line_text_field", value: "Lavaggio a 30°\nNon candeggiare" }] : [{ namespace: "custom", key: "dimensions", type: "single_line_text_field", value: pick(["40 × 40 cm", "120 × 60 × 75 cm", "Ø 30 cm", "200 × 300 cm"], p.id) }, { namespace: "custom", key: "care", type: "multi_line_text_field", value: "Wipe clean" }];
    // a version older than the last sync: the mock store reports the same, so edits are not stale
    if (p.platformUpdatedAt === null) fill.platformUpdatedAt = new Date((p.syncedAt ?? now).getTime() - ((i % 48) + 1) * 3600e3);
    if (Object.keys(fill).length) {
      await db.update(schema.products).set(fill).where(eq(schema.products.id, p.id));
      out.products++;
    }
    const origin = key === "northwind" ? pick(["IT", "PT", "RO"], p.id) : pick(["US", "MX", "PT"], p.id);
    const v = await db
      .update(schema.productVariants)
      .set({ inventoryPolicy: sql`coalesce(${schema.productVariants.inventoryPolicy}, ${i % 11 === 5 ? "continue" : "deny"})`, tracksInventory: sql`coalesce(${schema.productVariants.tracksInventory}, true)`, requiresShipping: sql`coalesce(${schema.productVariants.requiresShipping}, true)`, taxable: sql`coalesce(${schema.productVariants.taxable}, true)`, hsCode: sql`coalesce(${schema.productVariants.hsCode}, ${HS_CODES[p.productType ?? ""] ?? null})`, countryOfOrigin: sql`coalesce(${schema.productVariants.countryOfOrigin}, ${origin})` })
      .where(and(eq(schema.productVariants.productId, p.id), or(isNull(schema.productVariants.inventoryPolicy), isNull(schema.productVariants.tracksInventory), isNull(schema.productVariants.taxable), isNull(schema.productVariants.countryOfOrigin))))
      .returning({ id: schema.productVariants.id });
    out.variants += v.length;
  }
  return out;
}
