import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { MockConversionSink } from "@hullwise/integrations";
import type { PixelEvent } from "@hullwise/core";
import { conversionStats, enqueueConversions, ensurePixelSettings, ingestPixelBatch, PixelError, pixelOverview, retryFailedConversions, saveConversionSettings, sendDueConversions, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>, now?: Date) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null }, ...(now ? { now } : {}) }), pools.app);
const ev = (event: PixelEvent["event"], anonymousId: string, sessionId: string, extra: Partial<PixelEvent> = {}): PixelEvent => ({ event, anonymousId, sessionId, url: "https://shop.example/", referrer: null, props: {}, ...extra });
const meta = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 test" };

async function newOrder(n: number, email: string, placedAt: Date) {
  return run(async (s) => {
    const [c] = await s.tx.insert(schema.customers).values({ tenantId, email, emailNormalized: email, acceptsMarketing: true, firstName: "Px", lastName: `T${n}` }).returning({ id: schema.customers.id });
    const [o] = await s.tx.insert(schema.orders).values({ tenantId, customerId: c!.id, externalId: `px-${n}`, orderNumber: 970000 + n, name: `#PX-${n}`, email, emailNormalized: email, currency: "EUR", shippingCountry: "IT", paymentGateways: [], platformTags: [], paymentMethod: "card", paymentStatus: "paid", status: "confirmed", totalMinor: 15000, taxMinor: 0, subtotalMinor: 15000, placedAt }).returning({ id: schema.orders.id });
    return { customerId: c!.id, orderId: o!.id };
  });
}

describe("first-party pixel", () => {
  it("creates one touchpoint per session from its landing page, and stitches sessions to the order after checkout", async () => {
    await run((s) => ensurePixelSettings(s));
    const t0 = Date.now();
    const a = "anon-aaaaaaaa1";
    const r1 = await run((s) => ingestPixelBatch(s, [ev("page_view", a, "sess-aaaa0001", { url: "https://shop.example/p/1?fbclid=IwAR9&utm_source=facebook", ts: t0 - 3 * 864e5 }), ev("product_view", a, "sess-aaaa0001", { ts: t0 - 3 * 864e5 + 1000 })], meta), new Date(t0 - 3 * 864e5));
    expect(r1).toMatchObject({ accepted: 2, sessions: 1 });
    const r2 = await run((s) => ingestPixelBatch(s, [ev("add_to_cart", a, "sess-aaaa0001")], meta), new Date(t0 - 3 * 864e5 + 60_000));
    expect(r2.sessions).toBe(0);
    await run((s) => ingestPixelBatch(s, [ev("page_view", a, "sess-aaaa0002", { url: "https://shop.example/", referrer: "https://www.google.com/" })], meta), new Date(t0 - 864e5));
    const { orderId } = await newOrder(1, "pixel.one@example.com", new Date(t0 - 3600_000));
    const r3 = await run((s) => ingestPixelBatch(s, [ev("checkout_completed", a, "sess-aaaa0003", { props: { orderId: "px-1", email: "Pixel.One@example.com", fbp: "fb.1.1.2" } })], meta), new Date(t0));
    expect(r3.identities).toBe(1);
    // the thank-you page fires after the order: that session cannot have led to it
    expect(r3.stitched).toBe(2);
    const touches = await run((s) => s.tx.select().from(schema.touchpoints).where(and(eq(schema.touchpoints.tenantId, tenantId), eq(schema.touchpoints.orderId, orderId))));
    expect(touches.map((t) => t.channel).sort()).toEqual(["organic_search", "paid_social"]);
    const stored = await run((s) => s.tx.execute<{ props: Record<string, unknown>; client_ip: string | null }>(sql`select props, client_ip from pixel_events where tenant_id = ${tenantId} and event = 'checkout_completed' and anonymous_id = ${a}`));
    expect(stored.rows[0]!.props.email).toBeUndefined();
    expect(stored.rows[0]!.client_ip).toBe("203.0.113.7");
  });

  it("links a second device through the hashed email and credits its earlier session", async () => {
    const t0 = Date.now();
    await run((s) => ingestPixelBatch(s, [ev("page_view", "anon-phone0001", "sess-phone0001", { url: "https://shop.example/?utm_source=newsletter&utm_medium=email" }), ev("identify", "anon-phone0001", "sess-phone0001", { props: { email: "two@example.com" } })], meta), new Date(t0 - 2 * 864e5));
    const { orderId } = await newOrder(2, "two@example.com", new Date(t0 - 60_000));
    await run((s) => ingestPixelBatch(s, [ev("checkout_completed", "anon-desk0001", "sess-desk0001", { props: { orderId: "px-2" } })], meta), new Date(t0));
    const touches = await run((s) => s.tx.select({ channel: schema.touchpoints.channel }).from(schema.touchpoints).where(eq(schema.touchpoints.orderId, orderId)));
    expect(touches.map((t) => t.channel)).toContain("email");
  });

  it("rate-limits by hashed IP and reports health", async () => {
    const now = new Date();
    const batch = Array.from({ length: 25 }, (_, i) => ev("page_view", "anon-flood0001", `sess-flood${String(i).padStart(4, "0")}`));
    let blocked = false;
    for (let i = 0; i < 62 && !blocked; i++) {
      try {
        await run((s) => ingestPixelBatch(s, batch, { ip: "198.51.100.1", userAgent: null }), now);
      } catch (e) {
        blocked = e instanceof PixelError && e.code === "rate_limited";
      }
    }
    expect(blocked).toBe(true);
    const o = await run((s) => pixelOverview(s));
    expect(o.events).toBeGreaterThan(0);
    expect(o.ordersWithPixel).toBeGreaterThanOrEqual(2);
    expect(o.settings.publicKey).toMatch(/^px_/);
  });
});

describe("server-side conversions", () => {
  it("queues sale orders with consent, sends hashed events, retries failures and skips what a platform cannot match", async () => {
    await run((s) => saveConversionSettings(s, { provider: "meta", enabled: true, destinationId: "123", testEventCode: null, requireConsent: true, lookbackDays: 7 }));
    // the seed enables Google too: keep this test to one platform
    await run((s) => saveConversionSettings(s, { provider: "google", enabled: false, destinationId: "777", testEventCode: null, requireConsent: true, lookbackDays: 30 }));
    await run((s) => s.tx.delete(schema.conversionEvents).where(eq(schema.conversionEvents.tenantId, tenantId)));
    const q = await run((s) => enqueueConversions(s));
    expect(q.queued).toBeGreaterThan(0);
    const consent = await run((s) => s.tx.execute<{ n: number }>(sql`select count(*)::int as n from conversion_events ce join orders o on o.id = ce.order_id left join customers c on c.id = o.customer_id where ce.tenant_id = ${tenantId} and ce.status = 'pending' and not coalesce(c.accepts_marketing, false)`));
    expect(consent.rows[0]!.n).toBe(0);
    expect((await run((s) => enqueueConversions(s))).queued).toBe(0);
    const sink = new MockConversionSink("meta");
    sink.failures.failNext("rate_limited");
    const [failed] = await run((s) => sendDueConversions(s, () => sink));
    expect(failed!.failed).toBeGreaterThan(0);
    // backoff: nothing due right now
    expect((await run((s) => sendDueConversions(s, () => sink)))[0]!.sent).toBe(0);
    await run((s) => retryFailedConversions(s, "meta"));
    const [ok] = await run((s) => sendDueConversions(s, () => sink));
    expect(ok!.sent).toBe(failed!.failed);
    expect(JSON.stringify(sink.received)).not.toMatch(/@example|@[a-z]+\.(it|com)/);
    const px = sink.received.find((e) => e.orderExternalId === "px-1");
    expect(px?.fbp).toBe("fb.1.1.2");
    expect(px?.clientIp).toBe("203.0.113.7");
    const stats = await run((s) => conversionStats(s));
    expect(stats.find((x) => x.provider === "meta")!.sent).toBe(ok!.sent);
  });

  it("google skips events without click id or identifier", async () => {
    await run((s) => saveConversionSettings(s, { provider: "google", enabled: true, destinationId: "777", testEventCode: null, requireConsent: false, lookbackDays: 30 }));
    await run((s) => s.tx.update(schema.orders).set({ email: null, emailNormalized: null, phoneE164: null }).where(eq(schema.orders.externalId, "px-2")));
    await run((s) => s.tx.update(schema.customers).set({ email: null, phoneE164: null }).where(eq(schema.customers.email, "two@example.com")));
    await run((s) => enqueueConversions(s));
    const res = await run((s) => sendDueConversions(s, (p) => new MockConversionSink(p)));
    expect(res.find((r) => r.provider === "google")!.skipped).toBeGreaterThan(0);
  });
});
