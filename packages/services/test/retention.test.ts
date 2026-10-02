import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings, type TenantSettings } from "@hullwise/core";
import { MockMessagingChannel, emailAddressHash, maskEmail, type MessagingChannel } from "@hullwise/integrations";
import {
  suppressedContacts,
  STALE_CLAIM_MS, activateSequence, evaluateSegment, addEmailSuppression, addPhoneSuppression, approveRetentionCampaign, campaignTick, deleteRetentionCampaign, listRetentionCampaigns, pauseSequence, previewRetentionSend, processCampaignSend, recordManualCampaign,
  rejectRetentionCampaign, reopenRetentionCampaign, RetentionCampaignError, retentionCampaignDetail, retentionCampaignResults, saveRetentionCampaign, saveSegment, scheduleRetentionCampaign, sendCampaignTest, submitRetentionCampaign, suppressAddress,
  type AnalyticsTenant, type CampaignTenant, type ServiceContext, type TenantRunner,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
});
afterAll(() => pools.close());
const as = (email: string) => ctx.userIds[email]!;
const run = <T>(fn: (s: ServiceContext) => Promise<T>, id = tenantId, user = "marketing@northwind.demo") => withTenant(id, (tx) => fn({ tenantId: id, tx, actor: { type: "user", userId: as(user) } }), pools.app);
const system: TenantRunner = (fn) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
/** Settings that keep earlier tests out of the way: no cap, no lock, every hour open, a fast throttle. */
const loose = (over: Partial<TenantSettings> = {}): TenantSettings => ({ ...parseTenantSettings({}), campaignFrequencyCap: 100, campaignMeasurementLock: false, campaignSendStartHour: 0, campaignSendEndHour: 24, campaignThrottlePerMinute: { email: 100_000, sms: 100_000, whatsapp: 100_000 }, ...over });
const ct = (settings: TenantSettings): CampaignTenant => ({ id: tenantId, timezone: "Europe/Rome", settings });
let n = 0;
const segment = (rules: object, holdout = 30) => run((s) => saveSegment(s, { name: `Campaign test ${++n}`, rules, holdoutPercentage: holdout }));
const draft = (segmentId: string, over: Partial<Parameters<typeof saveRetentionCampaign>[1]> = {}) => run((s) => saveRetentionCampaign(s, { name: `Test ${++n}`, segmentId, channel: "email", message: "Hi {first_name}, {code}", discountCode: "TEST5", costPerMessageMinor: 3, attributionDays: 7, ...over }));
/** Draft → approved (by the owner) → scheduled at `at`. */
async function approvedAndScheduled(id: string, at: Date | null = null) {
  await run((s) => submitRetentionCampaign(s, id));
  await run((s) => approveRetentionCampaign(s, id, { role: "owner" }), tenantId, "owner@northwind.demo");
  await run((s) => scheduleRetentionCampaign(s, id, at));
}
async function exposures(campaignId: string) {
  return run((s) => s.tx.select({ customerId: schema.retentionExposures.customerId, groupName: schema.retentionExposures.groupName, status: schema.retentionExposures.status, email: schema.customers.email, key: schema.retentionExposures.idempotencyKey }).from(schema.retentionExposures).innerJoin(schema.customers, eq(schema.customers.id, schema.retentionExposures.customerId)).where(eq(schema.retentionExposures.campaignId, campaignId)));
}

describe("customer campaigns: results", () => {
  it("the seeded win-back is measured against its control group, with the code redemptions", async () => {
    // the sign of the uplift is checked on the full-size demo; at test scale the control group is a handful of customers
    const list = await run((s) => listRetentionCampaigns(s, tenant));
    const sent = list.find((c) => c.name.startsWith("Win-back clienti"))!;
    expect(sent.results!.report.measurable).toBe(true);
    expect(sent.results!.windowOpen).toBe(false);
    const r = sent.results!.report;
    expect(r.treated.customers + r.holdout.customers).toBe(sent.treatedCount + sent.holdoutCount);
    expect(r.treated.converters).toBeGreaterThanOrEqual(sent.results!.codeRedemptions);
    expect(sent.results!.codeRedemptions).toBeGreaterThan(0);
    expect(list.some((c) => c.status === "draft")).toBe(true);
    expect(list.some((c) => c.status === "pending_approval")).toBe(true);
    // the seeded sequence is measuring: its window stays open while it runs
    const sequence = list.find((c) => c.kind === "sequence")!;
    expect(sequence.status).toBe("active");
    expect(sequence.results!.windowOpen).toBe(true);
    expect(sequence.results!.report.treated.customers).toBe(sequence.treatedCount);
  });
});

describe("customer campaigns: approval", () => {
  it("draft → approval → approved → scheduled; the author cannot approve their own, a viewer cannot approve at all", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] });
    const id = await draft(segmentId);
    await expect(run((s) => scheduleRetentionCampaign(s, id, null))).rejects.toThrow("invalid_transition");
    await expect(run((s) => approveRetentionCampaign(s, id, { role: "owner" }), tenantId, "owner@northwind.demo")).rejects.toThrow("invalid_transition");
    await run((s) => submitRetentionCampaign(s, id));
    // the owner and the admin were told
    const notified = await run((s) => s.tx.select({ userId: schema.notifications.userId }).from(schema.notifications).where(and(eq(schema.notifications.type, "customer_campaign"), eq(schema.notifications.link, `/segments/campaigns/${id}`))));
    const told = new Set(notified.map((x) => x.userId));
    expect(told.has(as("owner@northwind.demo")) && told.has(as("admin@northwind.demo"))).toBe(true);
    expect(told.has(as("marketing@northwind.demo"))).toBe(false);
    expect(told.has(as("viewer@northwind.demo")) || told.has(as("ops@northwind.demo"))).toBe(false);
    await expect(run((s) => saveRetentionCampaign(s, { name: "x", segmentId, channel: "email", message: "", costPerMessageMinor: 0, attributionDays: 7 }, id))).rejects.toThrow("not_editable");
    await expect(run((s) => approveRetentionCampaign(s, id, { role: "marketing" }))).rejects.toThrow("own_campaign");
    await expect(run((s) => approveRetentionCampaign(s, id, { role: "viewer" }), tenantId, "viewer@northwind.demo")).rejects.toThrow("not_allowed");
    await expect(run((s) => approveRetentionCampaign(s, id, { role: "operations" }), tenantId, "ops@northwind.demo")).rejects.toThrow("not_allowed");
    // sent back with a note, changed, submitted again, approved by the admin
    await run((s) => rejectRetentionCampaign(s, id, { role: "admin", note: "Shorter text" }), tenantId, "admin@northwind.demo");
    expect((await run((s) => retentionCampaignDetail(s, tenant, id)))!.campaign).toMatchObject({ status: "draft", reviewNote: "Shorter text" });
    await run((s) => saveRetentionCampaign(s, { name: "Shorter", segmentId, channel: "email", message: "Hi", costPerMessageMinor: 0, attributionDays: 7 }, id));
    await run((s) => submitRetentionCampaign(s, id));
    const approved = await run((s) => approveRetentionCampaign(s, id, { role: "admin" }), tenantId, "admin@northwind.demo");
    expect(approved.to).toBe("approved");
    expect(approved.campaign.approvedBy).toBe(as("admin@northwind.demo"));
    const scheduled = await run((s) => scheduleRetentionCampaign(s, id, new Date(Date.now() + 864e5)));
    expect(scheduled.to).toBe("scheduled");
    // back to draft for a change: the approval is gone
    const reopened = await run((s) => reopenRetentionCampaign(s, id));
    expect(reopened.campaign).toMatchObject({ status: "draft", approvedBy: null, scheduledAt: null });
    await expect(run((s) => deleteRetentionCampaign(s, id))).resolves.toBeUndefined();
  });

  it("the owner may approve their own campaign; manual campaigns are recorded without approval", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 3 }] });
    const id = await run((s) => saveRetentionCampaign(s, { name: "Owner's", segmentId, channel: "sms", message: "x", costPerMessageMinor: 5, attributionDays: 10 }), tenantId, "owner@northwind.demo");
    await run((s) => submitRetentionCampaign(s, id), tenantId, "owner@northwind.demo");
    expect((await run((s) => approveRetentionCampaign(s, id, { role: "owner" }), tenantId, "owner@northwind.demo")).to).toBe("approved");

    const manual = await draft(segmentId, { channel: "manual", message: "" });
    await expect(run((s) => submitRetentionCampaign(s, manual))).rejects.toThrow("manual_channel");
    const channel = new MockMessagingChannel();
    const res = await run((s) => recordManualCampaign(s, manual, loose()));
    expect(channel.sent).toHaveLength(0);
    expect(res.treated).toBeGreaterThan(0);
    const detail = (await run((s) => retentionCampaignDetail(s, tenant, manual)))!;
    expect(detail.campaign.status).toBe("sent");
    expect(detail.campaign.deliveredCount).toBe(res.treated);
    await expect(run((s) => saveRetentionCampaign(s, { name: "Bad", segmentId, channel: "email", message: "", costPerMessageMinor: 0, attributionDays: 0 }))).rejects.toThrow("invalid_input");
    await expect(run((s) => saveRetentionCampaign(s, { name: "Bad", segmentId: "00000000-0000-0000-0000-000000000000", channel: "email", message: "", costPerMessageMinor: 0, attributionDays: 7 }))).rejects.toThrow("no_segment");
  });

  it("a test send goes to internal recipients only and is never an exposure", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] });
    const id = await draft(segmentId);
    const channel = new MockMessagingChannel();
    const r = await run((s) => sendCampaignTest(s, id, channel, [{ to: "marketing@northwind.demo", firstName: "Chiara" }]));
    expect(r.sent).toBe(1);
    expect(channel.sent[0]).toMatchObject({ to: "marketing@northwind.demo", template: "Hi Chiara, TEST5" });
    expect(await exposures(id)).toHaveLength(0);
    expect((await run((s) => retentionCampaignDetail(s, tenant, id)))!.campaign.testSentBy).toBe(as("marketing@northwind.demo"));
    await expect(run((s) => sendCampaignTest(s, id, channel, []))).rejects.toThrow("no_recipients");
  });
});

describe("customer campaigns: send queue", () => {
  it("is sent by the job at the scheduled time, within the send window and the per-minute throttle", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 1 }] });
    const id = await draft(segmentId);
    // asked for 06:00 Rome time: before the 09–20 window, so it waits for 09:00
    const day = "2026-06-10";
    const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+02:00`);
    await approvedAndScheduled(id, at("06:00"));
    const settings = loose({ campaignSendStartHour: 9, campaignSendEndHour: 20, campaignThrottlePerMinute: { email: 5, sms: 60, whatsapp: 60 } });
    const channel = new MockMessagingChannel();
    const early = await campaignTick(system, ct(settings), { now: at("06:30") });
    expect(early.started).toEqual([]);
    expect((await run((s) => retentionCampaignDetail(s, tenant, id)))!.campaign.status).toBe("scheduled");
    const tick = await campaignTick(system, ct(settings), { now: at("09:00") });
    expect(tick.started).toEqual([id]);
    expect(tick.delivering).toContain(id);
    const first = await processCampaignSend(system, ct(settings), id, channel, { now: at("09:00") });
    expect(first.status).toBe("throttled");
    expect(first.sent).toBe(5);
    expect(channel.sent).toHaveLength(5);
    // same minute: nothing more
    const again = await processCampaignSend(system, ct(settings), id, channel, { now: new Date(at("09:00").getTime() + 30_000) });
    expect(again).toMatchObject({ status: "throttled", sent: 0 });
    const next = await processCampaignSend(system, ct(settings), id, channel, { now: new Date(at("09:00").getTime() + 61_000) });
    expect(next.sent).toBe(5);
    // after the window closes nothing goes out; the rest waits for the next morning
    const late = await processCampaignSend(system, ct({ ...settings, campaignThrottlePerMinute: { email: 100_000, sms: 60, whatsapp: 60 } }), id, channel, { now: at("20:30") });
    expect(late.status).toBe("outside_window");
    expect(late.retryInMs).toBe(at("09:00").getTime() + 864e5 - at("20:30").getTime());
    const rest = await processCampaignSend(system, ct({ ...settings, campaignThrottlePerMinute: { email: 100_000, sms: 60, whatsapp: 60 } }), id, channel, { now: new Date(at("10:00").getTime() + 864e5) });
    expect(rest.status).toBe("done");
    const rows = await exposures(id);
    const treated = rows.filter((r) => r.groupName === "treated");
    expect(channel.sent.length).toBe(treated.filter((r) => r.status === "sent").length);
    expect(new Set(channel.sent.map((m) => m.to)).size).toBe(channel.sent.length);
    expect(rows.filter((r) => r.status === "queued" || r.status === "sending")).toHaveLength(0);
    const detail = (await run((s) => retentionCampaignDetail(s, tenant, id)))!;
    expect(detail.campaign.status).toBe("sent");
    expect(detail.campaign.sentAt!.toISOString()).toBe(at("09:00").toISOString());
    expect(detail.progress.pending).toBe(0);
    expect(detail.progress.sent).toBe(detail.campaign.deliveredCount);
    // holdout customers were recorded and never messaged
    const messaged = new Set(channel.sent.map((m) => m.to));
    expect(rows.some((r) => r.groupName === "holdout")).toBe(true);
    for (const h of rows.filter((r) => r.groupName === "holdout")) expect(messaged.has(h.email!)).toBe(false);
  });

  it("never messages suppressed, over-cap, open-order or in-measurement customers, and counts them by reason", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 1 }, { field: "accepts_marketing", op: "eq", value: true }] }, 20);
    await run((s) => evaluateSegment(s, segmentId));
    const m = await run((s) => s.tx.execute<{ customer_id: string; email: string; group_name: string; phone_e164: string | null }>(sql`select m.customer_id, c.email, m.group_name, c.phone_e164 from segment_memberships m join customers c on c.id = m.customer_id where m.segment_id = ${segmentId} and c.email is not null and m.group_name = 'treated' order by m.customer_id limit 6`));
    const [tenantBlock, bounced, overCap, openOrder, measured, phoneBlock] = m.rows;
    await run((s) => addEmailSuppression(s, { email: tenantBlock!.email, reason: "unsubscribe", category: "marketing" }));
    await suppressAddress(pools.admin, { emailHash: emailAddressHash(bounced!.email), emailMasked: maskEmail(bounced!.email), reason: "bounce" });
    // another campaign: three messages in the last days for one customer, a control-group exposure still in its window for another
    const other = await run(async (s) => (await s.tx.insert(schema.retentionCampaigns).values({ tenantId, name: "Earlier", segmentId, channel: "email", status: "sent", attributionDays: 30, sentAt: new Date(Date.now() - 2 * 864e5) }).returning())[0]!);
    const others = await run(async (s) => (await s.tx.insert(schema.retentionCampaigns).values([1, 2].map((i) => ({ tenantId, name: `Earlier ${i}`, segmentId, channel: "sms", status: "sent", attributionDays: 1, sentAt: new Date(Date.now() - 5 * 864e5) }))).returning()));
    await run((s) => s.tx.insert(schema.retentionExposures).values([
      { tenantId, campaignId: other.id, customerId: overCap!.customer_id, groupName: "treated", status: "sent", exposedAt: new Date(Date.now() - 2 * 864e5), sentAt: new Date(Date.now() - 2 * 864e5) },
      ...others.map((o) => ({ tenantId, campaignId: o.id, customerId: overCap!.customer_id, groupName: "treated", status: "sent", exposedAt: new Date(Date.now() - 5 * 864e5), sentAt: new Date(Date.now() - 5 * 864e5) })),
      { tenantId, campaignId: other.id, customerId: measured!.customer_id, groupName: "holdout", status: "held_out", exposedAt: new Date(Date.now() - 2 * 864e5) },
    ]));
    await run((s) => s.tx.insert(schema.orders).values({ tenantId, customerId: openOrder!.customer_id, orderNumber: 990101, name: "#OPEN-1", status: "confirmed", placedAt: new Date(), currency: "EUR", shippingCountry: "IT", paymentGateways: [], platformTags: [], paymentMethod: "card", paymentStatus: "paid", totalMinor: 5000, taxMinor: 900, subtotalMinor: 4100 }));
    if (phoneBlock?.phone_e164) await run((s) => addPhoneSuppression(s, { phone: phoneBlock.phone_e164!, reason: "manual" }));
    const settings = loose({ campaignFrequencyCap: 3, campaignMeasurementLock: true });
    const id = await draft(segmentId);
    const preview = await run((s) => previewRetentionSend(s, id, settings));
    expect(preview.exclusions.suppressed).toBeGreaterThanOrEqual(phoneBlock?.phone_e164 ? 3 : 2);
    expect(preview.exclusions.over_cap).toBeGreaterThanOrEqual(1);
    expect(preview.exclusions.open_order).toBeGreaterThanOrEqual(1);
    expect(preview.exclusions.in_measurement).toBeGreaterThanOrEqual(1);
    expect(preview.exclusions.holdout).toBe(preview.holdout);
    expect(preview.members).toBe(Object.values(preview.exclusions).reduce((a, b) => a + b, 0) + preview.treated);
    await approvedAndScheduled(id);
    const channel = new MockMessagingChannel();
    await campaignTick(system, ct(settings));
    const out = await processCampaignSend(system, ct(settings), id, channel);
    expect(out.status).toBe("done");
    const messaged = new Set(channel.sent.map((x) => x.to));
    for (const c of [tenantBlock, bounced, overCap, openOrder, measured, ...(phoneBlock?.phone_e164 ? [phoneBlock] : [])]) expect(messaged.has(c!.email)).toBe(false);
    const rows = await exposures(id);
    // excluded members are in neither group; the control group is never messaged
    for (const c of [tenantBlock, bounced, overCap, openOrder, measured]) expect(rows.some((r) => r.customerId === c!.customer_id)).toBe(false);
    for (const h of rows.filter((r) => r.groupName === "holdout")) expect(messaged.has(h.email!)).toBe(false);
    expect(channel.sent.length).toBe(preview.treated - preview.noAddress);
    const detail = (await run((s) => retentionCampaignDetail(s, tenant, id)))!;
    expect(detail.campaign.exclusionCounts).toMatchObject({ over_cap: preview.exclusions.over_cap, open_order: preview.exclusions.open_order });
  });

  it("an unsubscribe that arrives while the campaign is sending is honoured", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] });
    const id = await draft(segmentId);
    await approvedAndScheduled(id);
    const settings = loose();
    await campaignTick(system, ct(settings));
    const [queued] = (await exposures(id)).filter((r) => r.status === "queued");
    await run((s) => addEmailSuppression(s, { email: queued!.email!, reason: "unsubscribe", category: "all" }));
    const channel = new MockMessagingChannel();
    await processCampaignSend(system, ct(settings), id, channel);
    expect(channel.sent.some((m) => m.to === queued!.email)).toBe(false);
    expect((await exposures(id)).find((r) => r.customerId === queued!.customerId)!.status).toBe("suppressed");
  });

  it("a worker killed mid-send is resumed by the next one without duplicates", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 1 }] });
    const id = await draft(segmentId);
    await approvedAndScheduled(id);
    const settings = loose();
    const t0 = new Date();
    await campaignTick(system, ct(settings), { now: t0 });
    const provider = new MockMessagingChannel();
    // the first worker hands 7 messages to the provider, then the process dies (the 8th call never returns)
    let calls = 0;
    const dying: MessagingChannel = { provider: "dying", testConnection: () => provider.testConnection(), verifyWebhook: (h, b) => provider.verifyWebhook(h, b), sendMessage: (input) => (++calls <= 7 ? provider.sendMessage(input) : new Promise<never>(() => undefined)) };
    void processCampaignSend(system, ct(settings), id, dying, { now: t0 });
    await waitFor(() => calls >= 8);
    expect(provider.sent).toHaveLength(7);
    const mid = await exposures(id);
    expect(mid.filter((r) => r.status === "sending").length).toBeGreaterThan(7);
    // a new worker right away leaves the claimed batch alone (it might still be running)…
    const soon = await processCampaignSend(system, ct(settings), id, provider, { now: new Date(t0.getTime() + 60_000) });
    expect(soon.status).not.toBe("done");
    // …and takes it over once the claim is stale: the 7 already delivered are resent with their key and not delivered twice
    const later = await processCampaignSend(system, ct(settings), id, provider, { now: new Date(t0.getTime() + STALE_CLAIM_MS + 60_000) });
    expect(later.status).toBe("done");
    const rows = await exposures(id);
    const sent = rows.filter((r) => r.status === "sent");
    expect(sent.length).toBe(rows.filter((r) => r.groupName === "treated" && r.status !== "skipped").length);
    expect(provider.sent).toHaveLength(sent.length);
    expect(new Set(provider.sent.map((m) => m.idempotencyKey)).size).toBe(provider.sent.length);
    expect(new Set(provider.sent.map((m) => m.to)).size).toBe(provider.sent.length);
    expect(new Set(sent.map((r) => r.key))).toEqual(new Set(provider.sent.map((m) => m.idempotencyKey)));
  });

  it("transient provider errors are retried with backoff; permanent ones fail", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 3 }] });
    const id = await draft(segmentId);
    await approvedAndScheduled(id);
    const settings = loose();
    const t0 = new Date();
    await campaignTick(system, ct(settings), { now: t0 });
    const provider = new MockMessagingChannel();
    const { IntegrationError } = await import("@hullwise/integrations");
    let failedOnce = false;
    const flaky: MessagingChannel = { provider: "flaky", testConnection: () => provider.testConnection(), verifyWebhook: (h, b) => provider.verifyWebhook(h, b), sendMessage: async (input) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new IntegrationError("network", "timeout");
      }
      return provider.sendMessage(input);
    } };
    const first = await processCampaignSend(system, ct(settings), id, flaky, { now: t0 });
    expect(first.status).toBe("progress");
    expect(first.remaining).toBe(1);
    const retried = await processCampaignSend(system, ct(settings), id, flaky, { now: new Date(t0.getTime() + 61_000) });
    expect(retried.status).toBe("done");
    expect((await exposures(id)).filter((r) => r.status === "failed")).toHaveLength(0);
  });
});

describe("customer campaigns: sequences", () => {
  it("always-on: enrols entrants with their permanent group, sends to the treated ones, enrols newcomers later", async () => {
    const segmentId = await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 4 }] }, 25);
    await expect(draft(await segment({ match: "all", conditions: [{ field: "orders_count", op: "gte", value: 4 }] }, 0), { kind: "sequence" })).rejects.toThrow("sequence_needs_holdout");
    const id = await draft(segmentId, { kind: "sequence", attributionDays: 14 });
    await run((s) => submitRetentionCampaign(s, id));
    await run((s) => approveRetentionCampaign(s, id, { role: "owner" }), tenantId, "owner@northwind.demo");
    await expect(run((s) => scheduleRetentionCampaign(s, id, null))).rejects.toThrow("invalid_transition");
    await run((s) => activateSequence(s, id));
    const settings = loose();
    const channel = new MockMessagingChannel();
    const tick = await campaignTick(system, ct(settings));
    expect(tick.enrolled).toBeGreaterThan(0);
    await processCampaignSend(system, ct(settings), id, channel);
    const rows = await exposures(id);
    const groups = new Map((await run((s) => s.tx.select({ customerId: schema.segmentMemberships.customerId, groupName: schema.segmentMemberships.groupName }).from(schema.segmentMemberships).where(eq(schema.segmentMemberships.segmentId, segmentId)))).map((m) => [m.customerId, m.groupName]));
    for (const r of rows) expect(r.groupName).toBe(groups.get(r.customerId));
    expect(channel.sent.length).toBe(rows.filter((r) => r.status === "sent").length);
    // nothing new: the next tick enrols nobody and messages nobody twice
    expect((await campaignTick(system, ct(settings))).enrolled).toBe(0);
    // a newcomer (a customer reaching four orders) is picked up after the live refresh
    // earlier tests suppress some members (tenant list, platform bounce list): pick one the send would not exclude
    const pool = (await run((s) => s.tx.execute<{ customer_id: string; email: string | null; phone_e164: string | null }>(sql`
      select o.customer_id, c.email, c.phone_e164 from orders o join customers c on c.id = o.customer_id
      where o.tenant_id = ${tenantId} and o.replaced_by_order_id is null and c.accepts_marketing and c.email is not null
      group by 1, 2, 3 having count(*) filter (where o.status in ('confirmed', 'fulfilling', 'shipped', 'delivered', 'returned_partial')) = 3 and count(*) filter (where o.status in ('new', 'pending_review', 'confirmed', 'fulfilling', 'on_hold')) = 0
      order by 1 limit 50`))).rows;
    const blocked = await run((s) => suppressedContacts(s, pool.map((r) => ({ customerId: r.customer_id, email: r.email, phone: r.phone_e164 }))));
    const newcomer = pool.find((r) => !blocked.has(r.customer_id));
    expect(newcomer).toBeTruthy();
    await run((s) => s.tx.insert(schema.orders).values({ tenantId, customerId: newcomer!.customer_id, orderNumber: 990201, name: "#SEQ-1", status: "delivered", placedAt: new Date(Date.now() - 864e5), currency: "EUR", shippingCountry: "IT", paymentGateways: [], platformTags: [], paymentMethod: "card", paymentStatus: "paid", totalMinor: 5000, taxMinor: 900, subtotalMinor: 4100 }));
    const { refreshLiveSegments } = await import("../src");
    await run((s) => refreshLiveSegments(s));
    expect((await campaignTick(system, ct(settings))).enrolled).toBe(1);
    expect((await exposures(id)).some((r) => r.customerId === newcomer!.customer_id)).toBe(true);
    const results = await run((s) => retentionCampaignResults(s, tenant, id));
    expect(results!.windowOpen).toBe(true);
    await run((s) => pauseSequence(s, id));
    expect((await campaignTick(system, ct(settings))).delivering).not.toContain(id);
  });
});

describe("customer campaigns: tenancy", () => {
  it("another tenant sees none of these campaigns", async () => {
    const other = ctx.tenantIds.harbor;
    const otherTenant = { ...tenant, id: other };
    const mine = await run((s) => listRetentionCampaigns(s, tenant));
    const theirs = await run((s) => listRetentionCampaigns(s, otherTenant), other, "owner@harborhome.demo");
    for (const c of theirs) expect(mine.some((m) => m.id === c.id)).toBe(false);
    expect(await run((s) => retentionCampaignDetail(s, otherTenant, mine[0]!.id), other, "owner@harborhome.demo")).toBeNull();
    await expect(run((s) => submitRetentionCampaign(s, mine[0]!.id), other, "owner@harborhome.demo")).rejects.toBeInstanceOf(RetentionCampaignError);
    const ids = mine.map((m) => m.id);
    const leaked = await withTenant(other, (tx) => tx.select({ id: schema.retentionExposures.id }).from(schema.retentionExposures).where(inArray(schema.retentionExposures.campaignId, ids)), pools.app);
    expect(leaked).toHaveLength(0);
  });
});

async function waitFor(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
