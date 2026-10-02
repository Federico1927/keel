import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import type { MockCommercePlatform } from "@hullwise/integrations";
import { catalogSyncStatus, editProductMedia, editProductWithPlatform, getCommercePlatformFor, mockCommerceFor, processWebhookEvent, productVersion, recordWebhookEvent, resetMockPlatforms, runCatalogSync, syncProductFromPlatform, variantStock, type PlatformTenant, type ServiceContext } from "../src";
import { tenantSettingsSchema } from "@hullwise/core";

/** Issue #19: full Shopify mirror on read, two-way sync for a defined set of fields, gallery. */
const pools = testPools();
let seed: SeedContext;
let tenantId = "";
let otherTenantId = "";
let tenant: PlatformTenant;
let mock: MockCommercePlatform;
let userId: string | null = null;
const run = <T>(fn: (s: ServiceContext) => Promise<T>, as = tenantId) => withTenant(as, (tx) => fn({ tenantId: as, tx, actor: { type: "user", userId } }), pools.app);
const audit = () => ({ actorUserId: userId, actorType: "user" as const, impersonatedBy: null });
const platform = () => run((s) => getCommercePlatformFor(s, tenant));

async function product(offset = 0) {
  const [p] = await run((s) => s.tx.select().from(schema.products).where(and(eq(schema.products.tenantId, tenantId), sql`${schema.products.externalId} is not null`)).orderBy(asc(schema.products.title)).offset(offset).limit(1));
  return p!;
}
const productById = async (id: string) => (await run((s) => s.tx.select().from(schema.products).where(eq(schema.products.id, id))))[0]!;
const variantsOf = (id: string) => run((s) => s.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.productId, id), eq(schema.productVariants.isActive, true))).orderBy(asc(schema.productVariants.title)));
const mediaOf = (id: string) => run((s) => s.tx.select().from(schema.productMedia).where(eq(schema.productMedia.productId, id)).orderBy(asc(schema.productMedia.position)));
const lastAudit = async (action: string, entityId: string) => (await run((s) => s.tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.entityId, entityId))).orderBy(desc(schema.auditLogs.createdAt)).limit(1)))[0];
const version = (p: { platformUpdatedAt: Date | null; syncedAt: Date | null }) => productVersion(p)!.toISOString();

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  tenantId = seed.tenantIds.northwind;
  otherTenantId = seed.tenantIds.harbor;
  userId = seed.userIds["owner@northwind.demo"] ?? null;
  const [t] = await pools.admin.select({ id: schema.tenants.id, currency: schema.tenants.currency, country: schema.tenants.country, orderNumberPrefix: schema.tenants.orderNumberPrefix }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  tenant = t!;
  resetMockPlatforms();
  await platform();
  mock = mockCommerceFor(tenantId)!;
});
afterAll(() => pools.close());

describe("demo catalog and the mock store", () => {
  it("every demo product has a gallery served by the app, variant images and the mirror fields", async () => {
    const all = await run((s) => s.tx.select().from(schema.products).where(eq(schema.products.tenantId, tenantId)));
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.imageUrl).toMatch(/^\/demo-media\/.+\.svg$/);
      expect(p.descriptionHtml).toBeTruthy();
      expect(p.categoryId).toBeTruthy();
      expect(p.platformUpdatedAt).toBeTruthy();
    }
    const p = await product();
    const media = await mediaOf(p.id);
    expect(media.length).toBeGreaterThan(1);
    expect(media[0]!.url).toBe(p.imageUrl);
    expect((await variantsOf(p.id)).every((v) => media.some((m) => m.id === v.imageMediaId))).toBe(true);
    // the thumbnails of the stock lists: the variant's own image
    const stock = await run((s) => variantStock(s, tenantSettingsSchema.parse({}), { productIds: [p.id] }));
    expect(stock.every((r) => r.imageUrl && media.some((m) => m.url === r.imageUrl))).toBe(true);
  });

  it("a catalog sync of the untouched mock store changes nothing in the mirror", async () => {
    const p = await product();
    const before = { product: await productById(p.id), media: await mediaOf(p.id), variants: await variantsOf(p.id) };
    const r = await run(async (s) => runCatalogSync(s, await getCommercePlatformFor(s, tenant), { kind: "manual" }));
    expect(r).toMatchObject({ finished: true, error: null });
    const after = await productById(p.id);
    expect({ ...after, syncedAt: null, updatedAt: null }).toEqual({ ...before.product, syncedAt: null, updatedAt: null });
    expect((await mediaOf(p.id)).map((m) => [m.id, m.url, m.alt, m.position])).toEqual(before.media.map((m) => [m.id, m.url, m.alt, m.position]));
    expect((await variantsOf(p.id)).map((v) => [v.id, v.imageMediaId, v.priceMinor, v.inventoryPolicy])).toEqual(before.variants.map((v) => [v.id, v.imageMediaId, v.priceMinor, v.inventoryPolicy]));
  });
});

describe("two-way product fields", () => {
  it("writes title, description, tags, status, SEO and variant price, compare-at and SKU to the platform first, then stores its answer with an audit entry", async () => {
    const p = await product(1);
    const [v1, v2] = await variantsOf(p.id);
    const writes = mock.writeLog.length;
    const out = await run(async (s) =>
      editProductWithPlatform(s, await getCommercePlatformFor(s, tenant), p.id, {
        version: version(p),
        product: { title: `${p.title} Light`, descriptionHtml: "<p>Nuova descrizione</p>", tags: [...p.tags, "summer"], status: "draft", seoTitle: "SEO title", seoDescription: "SEO description" },
        variants: [{ variantId: v1!.id, priceMinor: v1!.priceMinor + 1000, compareAtMinor: v1!.priceMinor + 3000, sku: `${v1!.sku}-X` }, { variantId: v2!.id, priceMinor: v2!.priceMinor }],
      }, audit()),
    );
    expect(out.kind).toBe("updated");
    const log = mock.writeLog.slice(writes);
    expect(log.map((w) => w.op)).toEqual(["updateProduct", "updateVariant"]);
    expect(log[0]!.args).toMatchObject({ externalId: p.externalId, patch: { title: `${p.title} Light`, status: "draft", seo: { title: "SEO title", description: "SEO description" } } });
    expect(log[1]!.args).toEqual({ variantExternalId: v1!.externalId, patch: { priceMinor: v1!.priceMinor + 1000, compareAtMinor: v1!.priceMinor + 3000, sku: `${v1!.sku}-X` } });
    const after = await productById(p.id);
    expect(after).toMatchObject({ title: `${p.title} Light`, descriptionHtml: "<p>Nuova descrizione</p>", status: "draft", seoTitle: "SEO title", seoDescription: "SEO description" });
    expect(after.tags).toContain("summer");
    // the local version is the platform's, so the next edit from the reloaded page is not stale
    expect(after.platformUpdatedAt!.getTime()).toBeGreaterThan(p.platformUpdatedAt!.getTime());
    expect((await mock.fetchProduct(p.externalId!))!.platformUpdatedAt!.getTime()).toBe(after.platformUpdatedAt!.getTime());
    const [nv1] = await variantsOf(p.id);
    expect(nv1).toMatchObject({ priceMinor: v1!.priceMinor + 1000, compareAtMinor: v1!.priceMinor + 3000, sku: `${v1!.sku}-X` });
    const entry = await lastAudit("product.updated", p.id);
    expect(entry).toMatchObject({ actorUserId: userId, diff: { title: { from: p.title, to: `${p.title} Light` }, status: { from: "active", to: "draft" }, [`priceMinor:${v1!.title}`]: { from: v1!.priceMinor, to: v1!.priceMinor + 1000 }, [`sku:${v1!.title}`]: { from: v1!.sku, to: `${v1!.sku}-X` } } });
    // price edits keep feeding the price history (#30)
    const [change] = await run((s) => s.tx.select().from(schema.priceChanges).where(eq(schema.priceChanges.variantId, v1!.id)).orderBy(desc(schema.priceChanges.createdAt)).limit(1));
    expect(change).toMatchObject({ priceBeforeMinor: v1!.priceMinor, priceAfterMinor: v1!.priceMinor + 1000, compareAtAfterMinor: v1!.priceMinor + 3000, source: "manual" });
    // every call is in the outbox as a synchronous write
    const ws = await run((s) => s.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, tenantId), eq(schema.platformWrites.entityId, p.id))).orderBy(desc(schema.platformWrites.createdAt)));
    expect(ws.find((w) => w.kind === "product.update")).toMatchObject({ mode: "sync", status: "succeeded" });
    const vw = await run((s) => s.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.kind, "variant.details"), eq(schema.platformWrites.entityId, v1!.id))));
    expect(vw[0]).toMatchObject({ mode: "sync", status: "succeeded" });
    // nothing to change: no platform call
    const same = mock.writeLog.length;
    const again = await run(async (s) => editProductWithPlatform(s, await getCommercePlatformFor(s, tenant), p.id, { version: version(after), product: { title: after.title } }, audit()));
    expect(again.kind).toBe("unchanged");
    expect(mock.writeLog.length).toBe(same);
  });

  it("refuses an edit opened before the product changed in Shopify, and refreshes the mirror", async () => {
    const p = await product(2);
    const opened = version(p);
    mock.simulateExternalEdit(p.externalId!, { title: "Renamed in Shopify" });
    const writes = mock.writeLog.length;
    const out = await run(async (s) => editProductWithPlatform(s, await getCommercePlatformFor(s, tenant), p.id, { version: opened, product: { title: "My Hullwise title" } }, audit()));
    expect(out.kind).toBe("stale");
    expect(mock.writeLog.length).toBe(writes);
    const after = await productById(p.id);
    expect(after.title).toBe("Renamed in Shopify");
    // reloaded: the edit goes through on the new version
    const ok = await run(async (s) => editProductWithPlatform(s, await getCommercePlatformFor(s, tenant), p.id, { version: version(after), product: { title: "My Hullwise title" } }, audit()));
    expect(ok.kind).toBe("updated");
    expect((await productById(p.id)).title).toBe("My Hullwise title");
  });

  it("rejects invalid input and products of another tenant", async () => {
    const p = await product(3);
    const pf = await platform();
    expect(await run((s) => editProductWithPlatform(s, pf, p.id, { version: null, product: { title: " " } }, audit()))).toEqual({ kind: "invalid", error: "title_required" });
    expect((await run((s) => editProductWithPlatform(s, pf, p.id, { version: null, variants: [{ variantId: p.id, priceMinor: -5 }] }, audit()))).kind).toBe("invalid");
    expect((await run((s) => editProductWithPlatform(s, pf, p.id, { version: null, product: { title: "x" } }, audit()), otherTenantId)).kind).toBe("not_found");
    expect((await run((s) => editProductMedia(s, pf, p.id, { type: "delete", mediaIds: [], version: null }, audit()), otherTenantId)).kind).toBe("not_found");
  });

  it("edits a product Hullwise holds alone (no platform id) locally, with the same audit", async () => {
    const [local] = await run((s) => s.tx.insert(schema.products).values({ tenantId, title: "Local only", status: "active" }).returning());
    const out = await run(async (s) => editProductWithPlatform(s, await getCommercePlatformFor(s, tenant), local!.id, { version: null, product: { title: "Local renamed", tags: ["a"] } }, audit()));
    expect(out.kind).toBe("updated");
    expect(await productById(local!.id)).toMatchObject({ title: "Local renamed", tags: ["a"] });
    expect(await lastAudit("product.updated", local!.id)).toMatchObject({ metadata: { platform: false } });
  });
});

describe("gallery", () => {
  it("reorders, adds, changes alt text and deletes media on the platform, then stores its answer", async () => {
    const p = await product(4);
    const media = await mediaOf(p.id);
    const pf = await platform();
    const reversed = [...media].reverse().map((m) => m.id);
    let cur = await productById(p.id);
    expect((await run((s) => editProductMedia(s, pf, p.id, { type: "reorder", mediaIds: reversed, version: version(cur) }, audit()))).kind).toBe("updated");
    expect(mock.writeLog.at(-1)).toMatchObject({ op: "updateProductMedia", args: { externalId: p.externalId, op: { type: "reorder", mediaExternalIds: [...media].reverse().map((m) => m.externalId) } } });
    const reordered = await mediaOf(p.id);
    expect(reordered.map((m) => m.id)).toEqual(reversed);
    cur = await productById(p.id);
    expect(cur.imageUrl).toBe(reordered[0]!.url);
    expect(await lastAudit("product.media_reorder", p.id)).toMatchObject({ diff: { order: { from: media.map((m) => m.id), to: reversed } } });

    expect((await run((s) => editProductMedia(s, pf, p.id, { type: "create", url: "https://images.example/new.jpg", alt: "New", version: version(cur) }, audit()))).kind).toBe("updated");
    const added = await mediaOf(p.id);
    expect(added).toHaveLength(media.length + 1);
    expect(added.at(-1)).toMatchObject({ url: "https://images.example/new.jpg", alt: "New" });
    expect(added.at(-1)!.externalId).toMatch(/^gid:\/\/shopify\/MediaImage\//);

    cur = await productById(p.id);
    await run((s) => editProductMedia(s, pf, p.id, { type: "alt", mediaId: added.at(-1)!.id, alt: "Front", version: version(cur) }, audit()));
    expect((await mediaOf(p.id)).at(-1)!.alt).toBe("Front");

    cur = await productById(p.id);
    const victim = reordered[0]!;
    await run((s) => editProductMedia(s, pf, p.id, { type: "delete", mediaIds: [victim.id], version: version(cur) }, audit()));
    const left = await mediaOf(p.id);
    expect(left.map((m) => m.id)).not.toContain(victim.id);
    // variants that showed the deleted image fall back to none
    expect((await variantsOf(p.id)).some((v) => v.imageMediaId === victim.id)).toBe(false);
    expect((await run((s) => editProductMedia(s, pf, p.id, { type: "create", url: "javascript:alert(1)", alt: null, version: null }, audit()))).kind).toBe("invalid");
  });
});

describe("sync from Shopify", () => {
  it("updates one product from the platform, with an audit of what changed", async () => {
    const p = await product(5);
    mock.simulateExternalEdit(p.externalId!, { title: "Changed outside", descriptionHtml: "<p>outside</p>" });
    const r = await run(async (s) => syncProductFromPlatform(s, await getCommercePlatformFor(s, tenant), p.id, audit()));
    expect(r.kind).toBe("synced");
    expect(await productById(p.id)).toMatchObject({ title: "Changed outside", descriptionHtml: "<p>outside</p>" });
    expect(await lastAudit("product.synced", p.id)).toMatchObject({ diff: { title: { from: p.title, to: "Changed outside" } } });
  });

  it("the whole catalog sync picks up every change and reports progress in the run", async () => {
    const a = await product(6);
    const b = await product(7);
    mock.simulateExternalEdit(a.externalId!, { title: "Catalog A" });
    mock.simulateExternalEdit(b.externalId!, { seo: { title: "Catalog B SEO", description: null } });
    const r = await run(async (s) => runCatalogSync(s, await getCommercePlatformFor(s, tenant), { kind: "manual" }));
    expect(r.finished).toBe(true);
    expect((await productById(a.id)).title).toBe("Catalog A");
    expect((await productById(b.id)).seoTitle).toBe("Catalog B SEO");
    const status = await run((s) => catalogSyncStatus(s));
    expect(status.latest).toMatchObject({ status: "success", kind: "manual", phase: "finalize" });
    expect(status.latest!.products).toBe(status.totalProducts - 1); // the local-only product has no platform id
    expect(status.lastSuccessAt).toBeTruthy();
  });

  it("a products/update webhook reads the product back and refreshes the mirror", async () => {
    const p = await product(8);
    mock.simulateExternalEdit(p.externalId!, { title: "From webhook" });
    const env = mock.buildProductWebhook("products/update", p.externalId!);
    const verified = await mock.verifyWebhook(env.headers, env.rawBody);
    const ev = await run((s) => recordWebhookEvent(s, { source: "shopify", topic: "products/update", externalId: verified.externalId, sourceUpdatedAt: verified.sourceUpdatedAt, payload: verified.payload }));
    const res = await run(async (s) => processWebhookEvent(s, await getCommercePlatformFor(s, tenant), ev.id!, { country: tenant.country }));
    expect(res.status).toBe("processed");
    expect((await productById(p.id)).title).toBe("From webhook");
  });
});
