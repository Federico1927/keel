import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { EmailSendError, emailAddressHash, parseResendEvent } from "@hullwise/integrations";
import {
  EMAIL_LOCALES,
  EMAIL_STRINGS,
  EMAIL_TEMPLATE_NAMES,
  deliverEmailJob,
  drainEmailJobs,
  emailSettings,
  emailStats,
  listEmailLog,
  mockEmailOutbox,
  pendingEmailJobs,
  processEmailEvent,
  queueEmail,
  recordEmailEvent,
  renderEmail,
  sanitizeEmailError,
  sendTestEmail,
  type EmailJob,
  type EmailTemplate,
  type EmailTemplateData,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());

const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);
const platform = { db: pools.admin };
const takeJob = (): EmailJob => {
  const job = (pendingEmailJobs() as EmailJob[]).shift();
  if (!job) throw new Error("no job queued");
  return job;
};
const row = async (id: string) => (await pools.admin.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)))[0]!;
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000);

const SENDER = { product: "Hullwise", legalName: "Hullwise Labs S.r.l.", legalAddress: "Via Example 1, 20100 Milano", supportEmail: "support@hullwise.example" };
const SAMPLES: { [K in EmailTemplate]: EmailTemplateData[K] } = {
  magic_link: { url: "https://app.hullwise.example/api/auth/callback/email?token=abc123", minutes: 15 },
  email_change_confirm: { url: "https://app.hullwise.example/account/confirm-email?token=def456", hours: 24 },
  email_change_notice: { newEmail: "new@northwind.demo" },
  invite: { tenantName: "Northwind Apparel", inviterName: "Giulia", role: "operations", url: "https://app.hullwise.example/invite/tok", days: 7 },
  welcome: { name: "Marco", tenantName: "Northwind Apparel", dashboardUrl: "https://app.hullwise.example/t/northwind-apparel", profileUrl: "https://app.hullwise.example/t/northwind-apparel/profile", guideUrl: "https://app.hullwise.example/t/northwind-apparel/integrations/guide/shopify" },
  password_reset: { url: "https://app.hullwise.example/reset-password/tok", minutes: 60 },
  password_changed: { at: "2026-10-01T09:30:00.000Z", timezone: "Europe/Rome" },
  email_changed: { newEmail: "new@northwind.demo" },
  new_sign_in: { device: "Firefox · Windows", ip: "203.0.113.7", at: "2026-10-01T09:30:00.000Z", timezone: "Europe/Rome", profileUrl: "https://app.hullwise.example/t/northwind-apparel/profile" },
  account_disabled: { tenantName: "Northwind Apparel" },
  mention: { authorName: "Giulia", recordLabel: "#NW-1042", excerpt: "Can you check the address?\nThe courier called.", url: "https://app.hullwise.example/t/northwind-apparel/orders/1" },
  supplier_po: { companyName: "Northwind Apparel", supplierName: "Tessitura Rossi", poNumber: "PO-0042", url: "https://app.hullwise.example/supplier/po/tok", expectedAt: "2026-10-20T10:00:00.000Z", timezone: "Europe/Rome" },
  digest: { tenantName: "Northwind Apparel", groups: [{ type: "mention", count: 5, titles: ["#NW-1", "#NW-2"] }, { type: "late_to_ship", count: 1, titles: ["12"] }], url: "https://app.hullwise.example/t/northwind-apparel/notifications" },
  notification: { title: "4", body: "SKU-1", url: "https://app.hullwise.example/t/northwind-apparel/inventory", type: "stock_critical_no_po" },
  test: { provider: "mock", sentAt: "2026-10-01T09:30:00.000Z" },
  billing_checkout: { tenantName: "Harbor Home", planName: "Growth", lines: [{ kind: "plan", key: "growth", amountMinor: 59900 }, { kind: "addon", key: "addon.cod", amountMinor: 19900 }, { kind: "setup", key: "growth", amountMinor: 150000 }], currency: "USD", trialDays: 14, url: "https://checkout.stripe.com/c/pay/cs_test_a1", expiresAt: "2026-10-02T09:30:00.000Z", timezone: "Europe/Rome" },
  carrier_instruction: { companyName: "Northwind Apparel", carrier: "Carrier", trackingNumber: "TRK123", orderName: "#NW-1042", resolution: "new_address", address: { name: "Giulia Rossi", address1: "Via Roma 1", zip: "20121", city: "Milano", country: "IT" }, pickupPoint: null, note: "Ring twice" },
  return_approved: { ...{ storeName: "Northwind Apparel", customerName: "Giulia", returnNumber: "R-1042", orderName: "#NW-1042", items: [{ title: "Linen shirt · M", quantity: 1 }, { title: "Canvas sneaker · 40", quantity: 2 }] }, labelUrl: "https://app.hullwise.example/r/northwind-apparel/label/1?sig=abc", instructions: "Ship to: Returns, Via Roma 1, Milano.\nWrite R-1042 on the box." },
  return_received: { storeName: "Northwind Apparel", customerName: "Giulia", returnNumber: "R-1042", orderName: "#NW-1042", items: [{ title: "Linen shirt · M", quantity: 1 }, { title: "Canvas sneaker · 40", quantity: 2 }] },
  return_refunded: { ...{ storeName: "Northwind Apparel", customerName: "Giulia", returnNumber: "R-1042", orderName: "#NW-1042", items: [{ title: "Linen shirt · M", quantity: 1 }, { title: "Canvas sneaker · 40", quantity: 2 }] }, amountMinor: 4990, currency: "EUR" },
  return_voucher_issued: { ...{ storeName: "Northwind Apparel", customerName: "Giulia", returnNumber: "R-1042", orderName: "#NW-1042", items: [{ title: "Linen shirt · M", quantity: 1 }, { title: "Canvas sneaker · 40", quantity: 2 }] }, amountMinor: 5489, currency: "EUR", code: "V-1042-AB12C" },
  return_exchange_shipped: { ...{ storeName: "Northwind Apparel", customerName: "Giulia", returnNumber: "R-1042", orderName: "#NW-1042", items: [{ title: "Linen shirt · M", quantity: 1 }, { title: "Canvas sneaker · 40", quantity: 2 }] }, customerName: null, exchangeOrderName: "#NW-2210", carrier: "DHL", trackingNumber: "JD0123", trackingUrl: "https://track.example/JD0123" },
};

describe("templates", () => {
  it("every template renders in en, it and es (HTML and text snapshot)", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
    expect(keys(EMAIL_STRINGS.it)).toEqual(keys(EMAIL_STRINGS.en));
    expect(keys(EMAIL_STRINGS.es)).toEqual(keys(EMAIL_STRINGS.en));
    for (const template of EMAIL_TEMPLATE_NAMES)
      for (const locale of EMAIL_LOCALES) {
        const mail = renderEmail(template, locale, SAMPLES[template] as never, { sender: SENDER, unsubscribeUrl: "https://app.hullwise.example/u/signed" });
        expect(mail.subject, `${template}/${locale}`).not.toMatch(/\{\w+\}/);
        expect(mail.text, `${template}/${locale}`).not.toMatch(/\{\w+\}/);
        expect(mail.html).toContain(`<html lang="${locale}">`);
        expect(mail.html).toContain("Hullwise Labs S.r.l. · Via Example 1, 20100 Milano");
        expect(mail.html).toContain("support@hullwise.example");
        expect(mail.html).toContain("prefers-color-scheme:dark");
        expect({ subject: mail.subject, text: mail.text, html: mail.html }).toMatchSnapshot(`${template}.${locale}`);
      }
  });

  it("security emails carry no unsubscribe link; numbers and dates follow the locale", () => {
    const ml = renderEmail("magic_link", "it", SAMPLES.magic_link, { sender: SENDER, unsubscribeUrl: "https://x/u/1" });
    expect(ml.html).not.toContain("https://x/u/1");
    expect(ml.subject).toBe("Il tuo link di accesso a Hullwise");
    expect(renderEmail("supplier_po", "it", SAMPLES.supplier_po, { sender: SENDER }).text).toContain("20 ott 2026");
    expect(renderEmail("magic_link", "es", { url: "https://x/m?<b>", minutes: 15 }, { sender: SENDER }).html).toContain("https://x/m?&lt;b&gt;");
    expect(renderEmail("invite", "xx", SAMPLES.invite, { sender: SENDER }).subject).toBe("Giulia invited you to Northwind Apparel on Hullwise as operations");
  });
});

describe("store emails to their customers (return updates)", () => {
  it("carry the store's name, colour, logo and customer footer instead of the product's", () => {
    const store = { product: "Northwind Apparel", legalName: "Northwind Apparel", legalAddress: null, supportEmail: "help@northwind.example", brand: { primary: "#7a1f5c", onPrimary: "#ffffff", primaryDark: "#e3a6cc", onPrimaryDark: "#000000", logoUrl: "https://app.hullwise.example/brand/northwind-apparel/light?v=1" } };
    const mail = renderEmail("return_refunded", "it", SAMPLES.return_refunded, { sender: store, unsubscribeUrl: "https://app.hullwise.example/u/x" });
    expect(mail.subject).toBe("Rimborso effettuato per il reso R-1042");
    expect(mail.text).toContain("49,90");
    expect(mail.text).toContain("Ricevi questa email per un reso che hai richiesto a Northwind Apparel.");
    expect(mail.html).toContain('<img src="https://app.hullwise.example/brand/northwind-apparel/light?v=1"');
    expect(mail.html).toContain(".k-btn{background:#e3a6cc!important;color:#000000!important}");
    expect(renderEmail("return_approved", "it", SAMPLES.return_approved, { sender: store }).html).toContain('<td class="k-btn" style="background:#7a1f5c');
    expect(mail.html).toContain("help@northwind.example");
    expect(`${mail.text}${mail.html}`).not.toMatch(/Hullwise\b/);
    // without a label the approval says how to ship; the anonymous greeting has no name
    const noLabel = renderEmail("return_approved", "en", { ...SAMPLES.return_approved, labelUrl: null, customerName: null }, { sender: store });
    expect(noLabel.text).toContain("Hello,");
    expect(noLabel.text).toContain("send them back as described here");
    expect(noLabel.text).not.toContain("Download the return label");
  });
});

describe("provider selection", () => {
  it("uses Resend only with a key in live mode, and says when email is not configured", () => {
    expect(emailSettings({ HULLWISE_INTEGRATION_MODE: "live" })).toMatchObject({ provider: "mock", state: "not_configured" });
    expect(emailSettings({ HULLWISE_INTEGRATION_MODE: "live", NODE_ENV: "production" })).toMatchObject({ provider: "mock", state: "not_configured" });
    expect(emailSettings({ HULLWISE_INTEGRATION_MODE: "mock", RESEND_API_KEY: "re_x" })).toMatchObject({ provider: "mock", state: "mock_mode" });
    expect(emailSettings({ HULLWISE_INTEGRATION_MODE: "live", RESEND_API_KEY: "re_x", EMAIL_FROM: "Hullwise <no-reply@hullwise.example>", EMAIL_REPLY_TO: "support@hullwise.example" })).toMatchObject({ provider: "resend", state: "configured", from: "Hullwise <no-reply@hullwise.example>", replyTo: "support@hullwise.example", fromConfigured: true });
  });
});

describe("queue and delivery", () => {
  it("never sends inside the call: the job waits for the dispatcher", async () => {
    const before = mockEmailOutbox().sent.length;
    const q = await queueEmail(platform, { to: "queue@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "q1" });
    expect(q.outcome).toBe("queued");
    expect(mockEmailOutbox().sent.length).toBe(before);
    expect((await row(q.id)).status).toBe("queued");
    const [r] = await drainEmailJobs(pools.admin);
    expect(r).toMatchObject({ messageId: q.id, status: "sent" });
    expect(mockEmailOutbox().sent.length).toBe(before + 1);
  });

  it("a failed send is retried with backoff and never sent twice", async () => {
    const outbox = mockEmailOutbox();
    // queueing the same event twice is a no-op
    const q = await run((s) => queueEmail(s, { to: "retry@example.com", template: "notification", data: SAMPLES.notification, locale: "it", category: "stock_critical_no_po", event: "notification:retry" }));
    const dup = await run((s) => queueEmail(s, { to: "Retry@Example.com", template: "notification", data: SAMPLES.notification, locale: "it", category: "stock_critical_no_po", event: "notification:retry" }));
    expect(dup).toMatchObject({ id: q.id, outcome: "duplicate" });
    const job = takeJob();
    expect(pendingEmailJobs()).toHaveLength(0);
    // the provider accepts the message but the answer times out
    outbox.failNext("timeout", 1, true);
    const first = await deliverEmailJob(pools.admin, job);
    expect(first.status).toBe("queued");
    expect(first.retryInMs).toBeGreaterThan(0);
    expect(await row(q.id)).toMatchObject({ status: "queued", attempts: 1, lastErrorCode: "timeout" });
    // too early: nothing happens
    expect((await deliverEmailJob(pools.admin, job)).status).toBe("queued");
    // after the backoff the same job goes out with the same idempotency key: the provider keeps one copy
    const second = await deliverEmailJob(pools.admin, job, { now: new Date(Date.now() + first.retryInMs! + 1000) });
    expect(second.status).toBe("sent");
    expect(outbox.to("retry@example.com")).toHaveLength(1);
    // a redelivered job of a sent email does nothing
    expect((await deliverEmailJob(pools.admin, job)).status).toBe("sent");
    expect(outbox.to("retry@example.com")).toHaveLength(1);
    const final = await row(q.id);
    expect(final).toMatchObject({ status: "sent", attempts: 2, provider: "mock", lastErrorCode: null });
    expect(final.providerMessageId).toBe(outbox.to("retry@example.com")[0]!.id);
  });

  it("gives up after permanent errors and the maximum attempts", async () => {
    const outbox = mockEmailOutbox();
    const a = await queueEmail(platform, { to: "dead@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "perm" });
    outbox.failNext("domain_not_verified");
    expect((await deliverEmailJob(pools.admin, takeJob())).status).toBe("failed");
    expect(await row(a.id)).toMatchObject({ status: "failed", lastErrorCode: "domain_not_verified", attempts: 1 });
    const b = await queueEmail(platform, { to: "flaky@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "flaky" });
    const job = takeJob();
    outbox.failNext("rate_limit", 5);
    let at = Date.now();
    let last = await deliverEmailJob(pools.admin, job, { now: new Date(at) });
    while (last.retryInMs !== undefined) {
      at += last.retryInMs + 1;
      last = await deliverEmailJob(pools.admin, job, { now: new Date(at) });
    }
    expect(last.status).toBe("failed");
    expect(await row(b.id)).toMatchObject({ status: "failed", attempts: 5, lastErrorCode: "rate_limit" });
    expect(outbox.to("flaky@example.com")).toHaveLength(0);
  });

  it("security emails are never sent, nor retried, after their link expires", async () => {
    const outbox = mockEmailOutbox();
    await queueEmail(platform, { to: "late@example.com", template: "magic_link", data: SAMPLES.magic_link, locale: "en", event: "ml-late", expiresAt: inMinutes(15) });
    const job = takeJob();
    expect((await deliverEmailJob(pools.admin, job, { now: inMinutes(16) })).status).toBe("expired");
    expect(outbox.to("late@example.com")).toHaveLength(0);
    // a retry that would land after the expiry is not scheduled
    await queueEmail(platform, { to: "late2@example.com", template: "magic_link", data: SAMPLES.magic_link, locale: "en", event: "ml-late2", expiresAt: new Date(Date.now() + 10_000) });
    outbox.failNext("transient");
    expect((await deliverEmailJob(pools.admin, takeJob())).status).toBe("expired");
    await expect(queueEmail(platform, { to: "x@example.com", template: "magic_link", data: SAMPLES.magic_link, locale: "en", event: "no-expiry" })).rejects.toThrow("expiresAt");
  });
});

describe("bounces, complaints and the suppression list", () => {
  it("a hard-bounced address is not emailed again; a complaint still lets security emails through", async () => {
    const outbox = mockEmailOutbox();
    const q = await queueEmail(platform, { to: "bouncy@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "b1" });
    await drainEmailJobs(pools.admin);
    const providerId = (await row(q.id)).providerMessageId!;
    const event = parseResendEvent({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: providerId, to: ["Bouncy@example.com"], bounce: { type: "Permanent" } } })!;
    const rec = await recordEmailEvent(pools.admin, { provider: "resend", eventId: "msg_bounce_1", event });
    expect(rec.duplicate).toBe(false);
    expect((await recordEmailEvent(pools.admin, { provider: "resend", eventId: "msg_bounce_1", event })).duplicate).toBe(true);
    expect(await processEmailEvent(pools.admin, rec.id!)).toBe("processed");
    expect(await processEmailEvent(pools.admin, rec.id!)).toBe("processed");
    expect((await row(q.id)).status).toBe("bounced");
    const [sup] = await pools.admin.select().from(schema.emailAddressSuppressions).where(eq(schema.emailAddressSuppressions.emailHash, emailAddressHash("bouncy@example.com")));
    expect(sup).toMatchObject({ reason: "bounce", emailMasked: "bo•••@ex•••.com" });

    // every kind of email, security included, is now suppressed, for every tenant and the platform
    const before = outbox.to("bouncy@example.com").length;
    expect((await queueEmail(platform, { to: "bouncy@example.com", template: "magic_link", data: SAMPLES.magic_link, locale: "en", event: "b2", expiresAt: inMinutes(15) })).outcome).toBe("suppressed");
    expect((await run((s) => queueEmail(s, { to: "bouncy@example.com", template: "invite", data: SAMPLES.invite, locale: "en", event: "b3" }))).outcome).toBe("suppressed");
    await drainEmailJobs(pools.admin);
    expect(outbox.to("bouncy@example.com")).toHaveLength(before);

    // complaint: optional mail stops, sign-in links still go out
    const c = parseResendEvent({ type: "email.complained", data: { email_id: "x", to: ["spam@example.com"] } })!;
    await processEmailEvent(pools.admin, (await recordEmailEvent(pools.admin, { provider: "resend", eventId: "msg_complaint_1", event: c })).id!);
    expect((await run((s) => queueEmail(s, { to: "spam@example.com", template: "digest", data: SAMPLES.digest, locale: "en", event: "c1" }))).outcome).toBe("suppressed");
    expect((await queueEmail(platform, { to: "spam@example.com", template: "magic_link", data: SAMPLES.magic_link, locale: "en", event: "c2", expiresAt: inMinutes(15) })).outcome).toBe("queued");
    await drainEmailJobs(pools.admin);
    expect(outbox.to("spam@example.com")).toHaveLength(1);
  });

  it("an email queued before the bounce is suppressed at delivery; delivered events advance the status", async () => {
    const q = await queueEmail(platform, { to: "later@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "l1" });
    const job = takeJob();
    const ev = parseResendEvent({ type: "email.bounced", data: { email_id: "other", to: ["later@example.com"], bounce: { type: "Permanent" } } })!;
    await processEmailEvent(pools.admin, (await recordEmailEvent(pools.admin, { provider: "resend", eventId: "msg_bounce_2", event: ev })).id!);
    expect((await deliverEmailJob(pools.admin, job)).status).toBe("suppressed");
    expect((await row(q.id)).status).toBe("suppressed");

    const d = await queueEmail(platform, { to: "fine@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "d1" });
    await drainEmailJobs(pools.admin);
    const delivered = parseResendEvent({ type: "email.delivered", created_at: "2026-10-01T09:00:03.000Z", data: { email_id: (await row(d.id)).providerMessageId, to: ["fine@example.com"] } })!;
    await processEmailEvent(pools.admin, (await recordEmailEvent(pools.admin, { provider: "resend", eventId: "msg_delivered_1", event: delivered })).id!);
    expect(await row(d.id)).toMatchObject({ status: "delivered", deliveredAt: new Date("2026-10-01T09:00:03.000Z") });
    // a late "sent" or "delayed" event never moves a delivered email back
    const delayed = parseResendEvent({ type: "email.delivery_delayed", data: { email_id: (await row(d.id)).providerMessageId, to: ["fine@example.com"] } })!;
    await processEmailEvent(pools.admin, (await recordEmailEvent(pools.admin, { provider: "resend", eventId: "msg_delayed_1", event: delayed })).id!);
    expect((await row(d.id)).status).toBe("delivered");
  });
});

describe("delivery log", () => {
  it("never contains a token, a link or the address", async () => {
    const token = "SECRET-TOKEN-0123456789abcdefghijklmnop";
    const url = `https://app.hullwise.example/api/auth/callback/email?token=${token}&email=owner%40northwind.demo`;
    const q = await queueEmail(platform, { to: "Owner@Northwind.demo", template: "magic_link", data: { url, minutes: 15 }, locale: "it", event: `magic:${token}`, expiresAt: inMinutes(15) });
    // the provider error echoes the link and the address: it is sanitized before it is stored
    const job = takeJob();
    const echoing = { name: "mock" as const, send: async (): Promise<{ id: string }> => { throw new EmailSendError("transient", `bad link ${url} for owner@northwind.demo`); } };
    expect((await deliverEmailJob(pools.admin, job, { provider: echoing })).status).toBe("queued");
    await deliverEmailJob(pools.admin, job, { now: inMinutes(1) });
    const dump = JSON.stringify((await pools.admin.execute(sql`select to_jsonb(m) as row from email_messages m where id = ${q.id}`)).rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toMatch(/https?:/);
    expect(dump).not.toContain("owner@northwind.demo");
    expect(dump).toContain("ow•••@no•••.demo");
    // nothing anywhere in the log table carries a link or a token
    const all = JSON.stringify((await pools.admin.execute(sql`select to_jsonb(m) as row from email_messages m`)).rows);
    expect(all).not.toMatch(/https?:\/\/|token=/);
    expect(sanitizeEmailError(`see https://x.y/z?token=abc and mail a@b.co ${"k".repeat(40)}`)).toBe("see [link] and mail [email] [redacted]");
  });

  it("console: test email, last 7 days counts and log filters by tenant, status and recipient", async () => {
    const admin = ctx.userIds["superadmin@hullwise.demo"]!;
    const r = await sendTestEmail(pools.admin, { to: "console-test@example.com", locale: "it", actorUserId: admin });
    expect(r.outcome).toBe("queued");
    await drainEmailJobs(pools.admin);
    expect(mockEmailOutbox().to("console-test@example.com")[0]!.message.subject).toBe("Email di prova di Hullwise");
    const stats = await emailStats(pools.admin);
    expect(stats.sent).toBeGreaterThan(0);
    expect(stats.bounced).toBeGreaterThan(0);
    expect(stats.failed).toBeGreaterThan(0);
    const byRecipient = await listEmailLog(pools.admin, { recipient: "Console-Test@example.com" });
    expect(byRecipient.rows.map((x) => x.id)).toEqual([r.id]);
    expect(byRecipient.rows[0]).toMatchObject({ template: "test", tenantName: null, recipientMasked: "co•••@ex•••.com" });
    const tenantRows = await listEmailLog(pools.admin, { tenant: tenantId });
    expect(tenantRows.rows.length).toBeGreaterThan(0);
    expect(tenantRows.rows.every((x) => x.tenantId === tenantId)).toBe(true);
    expect((await listEmailLog(pools.admin, { status: "bounced" })).rows.every((x) => x.status === "bounced")).toBe(true);
    const [audit] = await pools.admin.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "email.test_sent"));
    expect(audit).toMatchObject({ actorUserId: admin, actorType: "super_admin" });
  });

  it("tenants read only their own log rows", async () => {
    await run((s) => queueEmail(s, { to: "own@example.com", template: "test", data: SAMPLES.test, locale: "en", event: "own" }));
    const harbor = ctx.tenantIds.harbor;
    const seen = await withTenant(harbor, (tx) => tx.select({ tenantId: schema.emailMessages.tenantId }).from(schema.emailMessages), pools.app);
    expect(seen.every((x) => x.tenantId === harbor)).toBe(true);
    const mine = await run((s) => s.tx.select({ tenantId: schema.emailMessages.tenantId }).from(schema.emailMessages));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.tenantId === tenantId)).toBe(true);
  });
});
