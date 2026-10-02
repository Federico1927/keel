import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { channelOfGa4Group } from "@hullwise/core";
import { MOCK_GA4_PROPERTY_ID, mockGa4ServiceAccountEmail, mockTrafficForStorage } from "@hullwise/integrations";
import * as schema from "../schema";
import { mockTrafficOrders } from "../traffic";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;
/** Months of traffic the backfill reads and the demo shows. */
export const GA4_BACKFILL_DAYS = 365;

/**
 * GA4 (#86): Northwind has its property connected to the simulator with 12 months of daily traffic built
 * from its own orders (conversion rate around 2%, the orders' seasonality and channel mix), a finished
 * backfill and a healthy source. Harbor Home is not connected, so its analytics show the empty state.
 */
export async function seedGa4(db: Db, key: "northwind" | "harbor", tenantId: string, opts: { now: Date; timeZone: string; storeName: string }) {
  await db.delete(schema.analyticsTrafficDaily).where(eq(schema.analyticsTrafficDaily.tenantId, tenantId));
  if (key !== "northwind") return;
  const { now } = opts;
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const since = day(new Date(now.getTime() - (GA4_BACKFILL_DAYS - 1) * DAY));
  const until = day(now);
  const orders = await mockTrafficOrders(db, tenantId, new Date(now.getTime() - (GA4_BACKFILL_DAYS + 2) * DAY));
  const rows = mockTrafficForStorage(orders, { since, until, timeZone: opts.timeZone, propertyId: MOCK_GA4_PROPERTY_ID });
  const values = rows.map((r) => ({ tenantId, provider: "ga4", propertyId: MOCK_GA4_PROPERTY_ID, ...r, channel: channelOfGa4Group(r.channelGroup), syncedAt: now }));
  for (let i = 0; i < values.length; i += 2000) await db.insert(schema.analyticsTrafficDaily).values(values.slice(i, i + 2000));
  await seedPixelBrowsing(db, tenantId, values, { now, since: day(new Date(now.getTime() - (PIXEL_BROWSING_DAYS - 1) * DAY)) });
  const synced = new Date(now.getTime() - 3 * 36e5);
  await db.insert(schema.integrations).values({ tenantId, provider: "ga4", status: "connected", mode: "mock", externalAccountId: MOCK_GA4_PROPERTY_ID, externalAccountName: `${opts.storeName} – GA4`, credentialsEncrypted: null, config: { installedVia: "mock", auth: "platform", serviceAccountEmail: mockGa4ServiceAccountEmail() }, lastSyncAt: synced, lastSuccessAt: synced, createdAt: new Date(now.getTime() - 400 * DAY) }).onConflictDoNothing();
  await db.insert(schema.integrationHealth).values({ tenantId, source: "ga4", status: "ok", lastSuccessAt: synced, lastAttemptAt: synced, lastMetricDate: until, rowsWrittenLast: values.filter((v) => v.date >= day(new Date(now.getTime() - 2 * DAY))).length, freshnessMinutes: 36 * 60 }).onConflictDoNothing();
  const total = values.reduce((s, v) => s + v.sessions, 0);
  await db.insert(schema.syncRuns).values([
    { tenantId, provider: "ga4", objectType: "traffic", kind: "backfill", status: "success", cursor: { since, until, window: Math.ceil(GA4_BACKFILL_DAYS / 7), counts: { rows: values.length, sessions: total } }, rowsWritten: values.length, rowsScanned: values.length, durationMs: 41_000, summary: { rows: values.length, sessions: total }, startedAt: new Date(now.getTime() - 30 * DAY), finishedAt: new Date(now.getTime() - 30 * DAY + 41_000) },
    { tenantId, provider: "ga4", objectType: "traffic", kind: "reconcile", status: "success", cursor: { since: day(new Date(now.getTime() - 2 * DAY)), until, window: 1, counts: {} }, rowsWritten: values.filter((v) => v.date >= day(new Date(now.getTime() - 2 * DAY))).length, rowsScanned: 0, durationMs: 1_900, summary: {}, startedAt: synced, finishedAt: new Date(synced.getTime() + 1_900) },
  ]);
}

/** Days of first-party pixel browsing the demo shows next to GA4 (the pixel was installed two weeks ago). */
const PIXEL_BROWSING_DAYS = 14;
const HOST = "https://northwind-apparel.example";
const hash = (k: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
};

/**
 * The pixel's own sessions over its coverage, next to GA4 (#86): the tracking seed writes only the
 * journeys that ended in an order, so the browsing that never converts is added here, from the same
 * daily rows: about 8–20% more sessions than GA4 per channel and landing page (the first-party pixel
 * loses fewer visitors to consent banners and blockers). One touchpoint and one page view per session.
 */
async function seedPixelBrowsing(db: Db, tenantId: string, rows: { date: string; channel: string; source: string; medium: string; campaignName: string; landingPath: string; sessions: number }[], opts: { now: Date; since: string }) {
  const touches: (typeof schema.touchpoints.$inferInsert)[] = [];
  const events: (typeof schema.pixelEvents.$inferInsert)[] = [];
  const real = (v: string) => (v && !v.startsWith("(") ? v : null);
  for (const r of rows) {
    if (r.date < opts.since || r.landingPath.startsWith("(")) continue;
    const key = `${r.date}|${r.channel}|${r.source}|${r.medium}|${r.campaignName}|${r.landingPath}`;
    const n = Math.round(r.sessions * (1.08 + 0.12 * ((hash(key) % 1000) / 1000)));
    const source = real(r.source);
    const medium = real(r.medium);
    const url = `${HOST}${r.landingPath}${source ? `?utm_source=${encodeURIComponent(source)}&utm_medium=${encodeURIComponent(medium ?? "")}` : ""}`;
    for (let i = 0; i < n; i++) {
      const h = hash(`${key}|${i}`);
      const at = new Date(Math.min(new Date(`${r.date}T12:00:00Z`).getTime() + ((h % 1080) - 540) * 60_000, opts.now.getTime() - 60_000 - (h % 600) * 1000));
      const anonymousId = `ab${h.toString(16)}${i.toString(36)}`;
      const sessionId = `sb${hash(`${key}|s|${i}`).toString(16)}${i.toString(36)}`;
      touches.push({ tenantId, anonymousId, sessionId, occurredAt: at, channel: r.channel, source, medium, utmCampaign: real(r.campaignName), paid: r.channel === "paid_social" || r.channel === "paid_search", landingUrl: url, origin: "pixel" });
      events.push({ tenantId, anonymousId, sessionId, event: "page_view", url, referrer: null, props: {}, occurredAt: at, receivedAt: at });
    }
  }
  for (let i = 0; i < touches.length; i += 2000) await db.insert(schema.touchpoints).values(touches.slice(i, i + 2000));
  for (let i = 0; i < events.length; i += 2000) await db.insert(schema.pixelEvents).values(events.slice(i, i + 2000));
}
