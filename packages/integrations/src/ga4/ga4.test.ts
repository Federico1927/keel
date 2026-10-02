import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { buildMockTraffic, MockAnalyticsPlatform, mockTrafficForStorage, type MockTrafficOrder } from "../mock/analytics";
import { GA4_DATA_API_BASE, Ga4AnalyticsPlatform, ga4QuotaError, ga4TrafficRequest, mapGa4Error, mapGa4TrafficRows, normalizeGa4PropertyId, parseGa4ServiceAccount, serviceAccountAssertion } from "./index";
import * as F from "./__fixtures__/ga4";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const keyFile = JSON.stringify({ type: "service_account", project_id: "northwind-analytics", private_key_id: "k1", private_key: privateKey, client_email: "hullwise-reader@northwind-analytics.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" });
const sa = parseGa4ServiceAccount(keyFile);
const isReport = (u: string) => u.startsWith(`${GA4_DATA_API_BASE}/properties/312456789:runReport`);
const offsetOf = (body?: string) => Number((JSON.parse(body ?? "{}") as { offset?: string }).offset ?? 0);

describe("GA4 mappers", () => {
  it("builds the recorded runReport body", () => {
    expect(ga4TrafficRequest({ since: "2026-09-27", until: "2026-09-28" })).toEqual(F.trafficRequest);
  });

  it("maps rows by header name, normalises the landing page to its path, keeps GA4 placeholders", () => {
    const rows = mapGa4TrafficRows(F.trafficPage1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ date: "2026-09-27", channelGroup: "Paid Social", source: "facebook", medium: "paid", campaignName: "120000030199", landingPage: "/products/quilted-jacket?utm_source=facebook&utm_medium=paid&fbclid=IwAR36", landingPath: "/products/quilted-jacket", sessions: 412, totalUsers: 377, engagedSessions: 251, addToCarts: 38 });
    expect(rows[1]!.landingPath).toBe(rows[0]!.landingPath);
    expect(mapGa4TrafficRows(F.trafficPage2)[0]).toMatchObject({ date: "2026-09-28", source: "(direct)", landingPath: "(not set)", sessions: 96 });
    // columns in another order are still read right
    const swapped = { ...F.trafficPage2, metricHeaders: [...F.trafficPage2.metricHeaders].reverse(), rows: F.trafficPage2.rows.map((r) => ({ ...r, metricValues: [...r.metricValues].reverse() })) };
    expect(mapGa4TrafficRows(swapped)[1]).toMatchObject({ sessions: 75, totalUsers: 70, engagedSessions: 55, addToCarts: 9 });
    expect(mapGa4TrafficRows({})).toEqual([]);
  });

  it("reads property ids and service-account key files", () => {
    expect(normalizeGa4PropertyId("properties/312456789")).toBe("312456789");
    expect(normalizeGa4PropertyId(" 312456789 ")).toBe("312456789");
    expect(normalizeGa4PropertyId("G-ABC123")).toBeNull();
    expect(sa.client_email).toBe("hullwise-reader@northwind-analytics.iam.gserviceaccount.com");
    expect(() => parseGa4ServiceAccount("{not json")).toThrow(/not valid JSON/);
    expect(() => parseGa4ServiceAccount(JSON.stringify({ type: "authorized_user" }))).toThrow(/service_account/);
    expect(() => parseGa4ServiceAccount(JSON.stringify({ type: "service_account", client_email: "x@gmail.com", private_key: privateKey }))).toThrow(/client_email/);
  });

  it("signs the service-account assertion with RS256", () => {
    const jwt = serviceAccountAssertion(sa, Date.UTC(2026, 9, 2));
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString()) as Record<string, unknown>;
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: Date.UTC(2026, 9, 2) / 1000, exp: Date.UTC(2026, 9, 2) / 1000 + 3600 });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("GA4 error mapping", () => {
  it("maps quota, auth, permission and request errors to the integration codes", () => {
    const hour = mapGa4Error(429, JSON.stringify(F.errors.quotaHour))!;
    expect(hour).toMatchObject({ code: "rate_limited", retryAfterMs: 1_800_000 });
    expect(hour.message).toMatch(/quota exhausted.*per hour/i);
    expect(mapGa4Error(429, JSON.stringify(F.errors.quotaDay))).toMatchObject({ code: "rate_limited", retryAfterMs: 6 * 3_600_000 });
    expect(mapGa4Error(403, JSON.stringify(F.errors.permission))).toMatchObject({ code: "permission", message: expect.stringMatching(/No access to the GA4 property/) });
    expect(mapGa4Error(403, JSON.stringify(F.errors.serviceDisabled))).toMatchObject({ code: "permission", message: expect.stringMatching(/Data API is not enabled/) });
    expect(mapGa4Error(401, JSON.stringify(F.errors.unauthenticated))).toMatchObject({ code: "token_expired" });
    expect(mapGa4Error(400, JSON.stringify(F.errors.invalidProperty))).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/Invalid property ID/) });
    expect(mapGa4Error(503, JSON.stringify(F.errors.unavailable))).toMatchObject({ code: "network" });
    expect(mapGa4Error(400, JSON.stringify(F.errors.invalidGrant))).toMatchObject({ code: "token_expired", message: "Google sign-in refused: invalid_grant (Invalid JWT Signature.)" });
    expect(mapGa4Error(200, "{}")).toBeNull();
  });

  it("reads the property quota block", () => {
    expect(ga4QuotaError(F.trafficPage1.propertyQuota)).toBeNull();
    expect(ga4QuotaError(F.trafficPageQuotaExhausted.propertyQuota)).toMatchObject({ code: "rate_limited", retryAfterMs: 1_800_000 });
    expect(ga4QuotaError({ tokensPerDay: { consumed: 200_000, remaining: 0 } })).toMatchObject({ code: "rate_limited", retryAfterMs: 6 * 3_600_000 });
    expect(ga4QuotaError(null)).toBeNull();
  });
});

describe("GA4 adapter on recorded fixtures", () => {
  const make = (routes: Parameters<typeof fixtureFetch>[0], creds: ConstructorParameters<typeof Ga4AnalyticsPlatform>[0] = { kind: "service_account", serviceAccount: sa }) => new Ga4AnalyticsPlatform(creds, { propertyId: "properties/312456789", fetchImpl: fixtureFetch(routes), sleep: async () => undefined, now: () => Date.UTC(2026, 9, 2) });

  it("exchanges the signed assertion once and reads every page", async () => {
    let tokenCalls = 0;
    const p = make([
      { match: (u, i) => u === "https://oauth2.googleapis.com/token" && (i?.body ?? "").includes("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="), body: () => (tokenCalls++, F.tokenResponse) },
      { match: (u, i) => isReport(u) && offsetOf(i?.body) === 0, body: F.trafficPage1 },
      { match: (u, i) => isReport(u) && offsetOf(i?.body) === 3, body: F.trafficPage2 },
    ]);
    const rows = await p.fetchDailyTraffic({ since: "2026-09-27", until: "2026-09-28" });
    expect(rows).toHaveLength(5);
    expect(tokenCalls).toBe(1);
    expect(JSON.parse(p.http.calls[1]!.body!)).toEqual(F.trafficRequest);
    expect(p.lastQuota?.tokensPerHour?.remaining).toBe(39_950);
  });

  it("uses the OAuth refresh token as the alternative", async () => {
    const p = make([
      { match: (u, i) => u === "https://oauth2.googleapis.com/token" && (i?.body ?? "").includes("grant_type=refresh_token&client_id=cid"), body: F.tokenResponse },
      { match: (u) => isReport(u), body: { ...F.trafficPage2, rowCount: 2 } },
    ], { kind: "oauth", clientId: "cid", clientSecret: "cs", refreshToken: "rt" });
    expect(await p.fetchDailyTraffic({ since: "2026-09-28", until: "2026-09-28" })).toHaveLength(2);
  });

  it("stops paging with rate_limited when the property quota hits zero", async () => {
    const p = make([
      { match: (u) => u.includes("oauth2"), body: F.tokenResponse },
      { match: (u, i) => isReport(u) && offsetOf(i?.body) === 0, body: F.trafficPageQuotaExhausted },
    ]);
    await expect(p.fetchDailyTraffic({ since: "2026-09-27", until: "2026-09-28" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("retries a 429 and then surfaces it as rate_limited with the quota wait", async () => {
    let calls = 0;
    const p = make([
      { match: (u) => u.includes("oauth2"), body: F.tokenResponse },
      { match: (u) => isReport(u), status: 429, body: () => (calls++, F.errors.quotaHour) },
    ]);
    await expect(p.fetchDailyTraffic({ since: "2026-09-27", until: "2026-09-28" })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 1_800_000 });
    expect(calls).toBe(3);
  });

  it("recovers from one 429 inside the retries", async () => {
    let calls = 0;
    const p = make([
      { match: (u) => u.includes("oauth2"), body: F.tokenResponse },
      { match: (u) => isReport(u) && calls++ === 0, status: 429, body: F.errors.quotaHour },
      { match: (u) => isReport(u), body: { ...F.trafficPage2, rowCount: 2 } },
    ]);
    expect(await p.fetchDailyTraffic({ since: "2026-09-28", until: "2026-09-28" })).toHaveLength(2);
  });

  it("tests the connection, names the property, lists properties across pages", async () => {
    const p = make([
      { match: (u) => u.includes("oauth2"), body: F.tokenResponse },
      { match: (u) => isReport(u), body: { ...F.trafficPage2, rowCount: 2 } },
      { match: (u) => u.endsWith("/v1beta/properties/312456789"), body: F.property },
      { match: (u) => u.includes("accountSummaries") && u.includes("pageToken=page-2"), body: F.accountSummariesPage2 },
      { match: (u) => u.includes("accountSummaries"), body: F.accountSummaries },
    ]);
    expect(await p.testConnection()).toMatchObject({ ok: true, accountId: "312456789", accountName: "Northwind Apparel – GA4" });
    expect(await p.listProperties()).toEqual([
      { propertyId: "312456789", displayName: "Northwind Apparel – GA4", accountName: "Northwind Apparel" },
      { propertyId: "312456790", displayName: "Northwind – staging", accountName: "Northwind Apparel" },
      { propertyId: "400000001", displayName: "Sandbox", accountName: "Agency sandbox" },
    ]);
  });

  it("reports readable failures from the connection test", async () => {
    const denied = make([{ match: (u) => u.includes("oauth2"), body: F.tokenResponse }, { match: (u) => isReport(u), status: 403, body: F.errors.serviceDisabled }]);
    expect(await denied.testConnection()).toMatchObject({ ok: false, error: expect.stringMatching(/Data API is not enabled/) });
    const badKey = make([{ match: (u) => u.includes("oauth2"), status: 400, body: F.errors.invalidGrant }]);
    expect(await badKey.testConnection()).toMatchObject({ ok: false, error: expect.stringMatching(/invalid_grant/) });
    // the property name is optional: without the Admin API the id is the name
    const noAdmin = make([{ match: (u) => u.includes("oauth2"), body: F.tokenResponse }, { match: (u) => isReport(u), body: { rowCount: 0 } }, { match: (u) => u.includes("analyticsadmin"), status: 403, body: F.errors.serviceDisabled }]);
    expect(await noAdmin.testConnection()).toMatchObject({ ok: true, accountName: "GA4 312456789" });
    expect(() => new Ga4AnalyticsPlatform({ kind: "oauth", clientId: "a", clientSecret: "b", refreshToken: "c" }, { propertyId: "G-123" })).toThrow(/property id/);
  });
});

describe("GA4 simulator", () => {
  const day = (iso: string, h = 12) => new Date(`${iso}T${String(h).padStart(2, "0")}:00:00Z`);
  const orders: MockTrafficOrder[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ placedAt: day("2026-09-27", 9 + i), landingSite: `/products/quilted-jacket?utm_source=facebook&utm_medium=paid&utm_campaign=120000030199&fbclid=F${i}`, channel: "paid_social", utmSource: "facebook", utmMedium: "paid", utmCampaign: "120000030199" })),
    { placedAt: day("2026-09-27"), landingSite: "/", channel: "direct", utmSource: null, utmMedium: null, utmCampaign: null },
    { placedAt: day("2026-09-28"), landingSite: "/products/oxford-shirt?utm_source=google&utm_medium=organic", channel: "organic_search", utmSource: "google", utmMedium: "organic", utmCampaign: null },
    { placedAt: new Date("2026-09-27T23:30:00Z"), landingSite: "/", channel: "direct", utmSource: null, utmMedium: null, utmCampaign: null },
  ];
  const opts = { since: "2026-09-27", until: "2026-09-28", timeZone: "Europe/Rome" };

  it("is deterministic, follows the orders and converts around the channel rates", () => {
    const a = buildMockTraffic(orders, opts);
    expect(buildMockTraffic(orders, opts)).toEqual(a);
    const paid = a.filter((r) => r.channelGroup === "Paid Social");
    expect(paid.reduce((s, r) => s + r.sessions, 0)).toBeGreaterThan(6 / 0.02 * 0.65);
    expect(paid.every((r) => r.landingPath === "/products/quilted-jacket" && r.campaignName === "120000030199" && !r.landingPage.includes("fbclid"))).toBe(true);
    // 23:30 UTC is the next day in Rome
    expect(a.some((r) => r.date === "2026-09-28" && r.channelGroup === "Direct")).toBe(true);
    // a day read alone gives the same numbers as inside a longer window
    expect(buildMockTraffic(orders, { ...opts, since: "2026-09-28" })).toEqual(a.filter((r) => r.date === "2026-09-28"));
    for (const r of a) expect(r.addToCarts).toBeLessThanOrEqual(r.sessions);
    // the staging property has a fraction of the traffic
    const staging = buildMockTraffic(orders, { ...opts, propertyId: "312456790" });
    expect(staging.reduce((s, r) => s + r.sessions, 0)).toBeLessThan(a.reduce((s, r) => s + r.sessions, 0) * 0.1);
    expect(mockTrafficForStorage(orders, opts).length).toBeLessThanOrEqual(a.length);
  });

  it("injects failures for the retry paths", async () => {
    const m = new MockAnalyticsPlatform({ orders, timeZone: "Europe/Rome", storeName: "Northwind Apparel" });
    m.failures.failNext("rate_limited");
    await expect(m.fetchDailyTraffic(opts)).rejects.toMatchObject({ code: "rate_limited" });
    expect((await m.fetchDailyTraffic(opts)).length).toBeGreaterThan(0);
    expect((await m.listProperties()).map((p) => p.propertyId)).toEqual(["312456789", "312456790"]);
    expect(await m.testConnection()).toMatchObject({ ok: true, accountName: "Northwind Apparel – GA4" });
  });
});

describe("GA4 with the platform service account", () => {
  it("reads the key from the environment (JSON or base64) and the e-mail to show", async () => {
    const { ga4ServiceAccountEmail, platformGa4ServiceAccount, requirePlatformGa4ServiceAccount } = await import("./platform");
    expect(platformGa4ServiceAccount({})).toBeNull();
    expect(platformGa4ServiceAccount({ HULLWISE_GA4_SERVICE_ACCOUNT_KEY: keyFile })?.client_email).toBe(sa.client_email);
    expect(platformGa4ServiceAccount({ HULLWISE_GA4_SERVICE_ACCOUNT_KEY: Buffer.from(keyFile).toString("base64") })?.client_email).toBe(sa.client_email);
    expect(platformGa4ServiceAccount({ HULLWISE_GA4_SERVICE_ACCOUNT_KEY: "{broken" })).toBeNull();
    expect(ga4ServiceAccountEmail({ HULLWISE_GA4_SERVICE_ACCOUNT_EMAIL: "reader@x.iam.gserviceaccount.com" })).toBe("reader@x.iam.gserviceaccount.com");
    expect(ga4ServiceAccountEmail({ HULLWISE_GA4_SERVICE_ACCOUNT_KEY: keyFile, HULLWISE_INTEGRATION_MODE: "live" })).toBe(sa.client_email);
    expect(ga4ServiceAccountEmail({ HULLWISE_INTEGRATION_MODE: "mock" })).toMatch(/^ga4-reader@.+-demo\.iam\.gserviceaccount\.com$/);
    expect(ga4ServiceAccountEmail({ HULLWISE_INTEGRATION_MODE: "live" })).toBeNull();
    expect(() => requirePlatformGa4ServiceAccount({})).toThrow(/not configured/);
  });

  it("explains a failed test in plain words", async () => {
    const { ga4SetupError, ga4SetupErrorFromText } = await import("./platform");
    const cases: [number, unknown, string][] = [[403, F.errors.permission, "no_access"], [403, F.errors.serviceDisabled, "api_unreachable"], [400, F.errors.invalidProperty, "wrong_property"], [429, F.errors.quotaHour, "quota"], [401, F.errors.unauthenticated, "credentials"], [503, F.errors.unavailable, "api_unreachable"]];
    for (const [status, body, want] of cases) {
      const e = mapGa4Error(status, JSON.stringify(body))!;
      expect(ga4SetupError(e.code, e.message), want).toBe(want);
      expect(ga4SetupErrorFromText(`[${e.code}] ${e.message}`), want).toBe(want);
    }
    expect(ga4SetupErrorFromText(null)).toBeNull();
    expect(ga4SetupError(null, "something else")).toBe("unknown");
    const denied = new Ga4AnalyticsPlatform({ kind: "service_account", serviceAccount: sa }, { propertyId: "312456789", fetchImpl: fixtureFetch([{ match: (u) => u.includes("oauth2"), body: F.tokenResponse }, { match: (u) => isReport(u), status: 403, body: F.errors.permission }]), sleep: async () => undefined });
    expect(await denied.testConnection()).toMatchObject({ ok: false, errorCode: "permission" });
    // the simulator answers like GA4 for a property the reader was not added to
    const mock = new MockAnalyticsPlatform({ orders: [], timeZone: "UTC", storeName: "Store", propertyId: "999999999" });
    expect(await mock.testConnection()).toMatchObject({ ok: false, errorCode: "permission" });
  });
});
