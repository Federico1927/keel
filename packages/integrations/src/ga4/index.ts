import { createSign } from "node:crypto";
import { ga4DateToIso, normalizeLandingPath, TRAFFIC_NOT_SET } from "@hullwise/core";
import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type AnalyticsPlatform, type AnalyticsProperty, type ConnectionTest, type NormalizedTrafficRow } from "../types";

/**
 * Google Analytics 4 (#86): the Data API `runReport` for daily traffic, the Admin API for the property
 * picker. Versions checked on 2026-10-02 [to verify before each release: Google moves GA4 APIs from
 * beta to v1 without much notice]; the fixtures in `__fixtures__/` are the request and response shapes.
 */
export const GA4_DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
export const GA4_ADMIN_API_BASE = "https://analyticsadmin.googleapis.com/v1beta";
export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Dimensions and metrics of the daily traffic report, in request order. */
export const GA4_TRAFFIC_DIMENSIONS = ["date", "sessionDefaultChannelGroup", "sessionSource", "sessionMedium", "sessionCampaignName", "landingPagePlusQueryString"] as const;
export const GA4_TRAFFIC_METRICS = ["sessions", "totalUsers", "engagedSessions", "addToCarts"] as const;
/** Rows per `runReport` page (the API accepts up to 250,000; smaller pages keep each call well under the token quota). */
export const GA4_PAGE_SIZE = 10_000;

/** The key file Google Cloud gives for a service account (only the fields Hullwise reads). */
export interface Ga4ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}
/** Service account (preferred: no user token to expire) or OAuth with a refresh token. The property id lives on the integration row. */
export type Ga4Credentials = { kind: "service_account"; serviceAccount: Ga4ServiceAccount } | { kind: "oauth"; clientId: string; clientSecret: string; refreshToken: string };

/** Reads a pasted service-account key file; throws `invalid_request` with a readable reason. */
export function parseGa4ServiceAccount(json: string): Ga4ServiceAccount {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new IntegrationError("invalid_request", "The service account key is not valid JSON");
  }
  if (v.type !== "service_account") throw new IntegrationError("invalid_request", "The JSON is not a service account key (type must be service_account)");
  const email = typeof v.client_email === "string" ? v.client_email.trim() : "";
  const key = typeof v.private_key === "string" ? v.private_key : "";
  if (!/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email)) throw new IntegrationError("invalid_request", "client_email is missing or is not a service account address");
  if (!key.includes("PRIVATE KEY")) throw new IntegrationError("invalid_request", "private_key is missing");
  return { client_email: email, private_key: key, token_uri: typeof v.token_uri === "string" ? v.token_uri : GOOGLE_TOKEN_URI, project_id: typeof v.project_id === "string" ? v.project_id : undefined };
}

/** `properties/123` or `123` → `123`; null when it is not a numeric GA4 property id. */
export function normalizeGa4PropertyId(v: string): string | null {
  const id = v.trim().replace(/^properties\//, "");
  return /^\d{5,15}$/.test(id) ? id : null;
}

type Quota = { consumed?: number; remaining?: number };
export interface Ga4PropertyQuota {
  tokensPerDay?: Quota;
  tokensPerHour?: Quota;
  tokensPerProjectPerHour?: Quota;
  concurrentRequests?: Quota;
  serverErrorsPerProjectPerHour?: Quota;
  potentiallyThresholdedRequestsPerHour?: Quota;
}

const HOUR = 3_600_000;
/** Wait before retrying after a quota error, by which quota ran out (the message names it). */
function quotaWait(message: string): number {
  if (/per day/i.test(message)) return 6 * HOUR;
  if (/per hour/i.test(message)) return HOUR / 2;
  if (/concurrent/i.test(message)) return 10_000;
  return 60_000;
}

/**
 * The property quota returned with a report (`returnPropertyQuota`): a quota at zero would fail the
 * next call, so the adapter stops paging with `rate_limited` and the sync resumes the window later.
 */
export function ga4QuotaError(q: Ga4PropertyQuota | null | undefined): IntegrationError | null {
  if (!q) return null;
  const out = (name: string, v: Quota | undefined) => v?.remaining !== undefined && v.remaining <= 0 ? name : null;
  const day = out("tokens per day", q.tokensPerDay);
  if (day) return new IntegrationError("rate_limited", `GA4 quota exhausted: property ${day}`, quotaWait("per day"));
  const hour = out("tokens per hour", q.tokensPerHour) ?? out("tokens per project per hour", q.tokensPerProjectPerHour) ?? out("server errors per project per hour", q.serverErrorsPerProjectPerHour);
  if (hour) return new IntegrationError("rate_limited", `GA4 quota exhausted: property ${hour}`, quotaWait("per hour"));
  return null;
}

/**
 * Google API error bodies → `IntegrationError`: `{ error: { code, status, message, details } }` from the
 * Data and Admin APIs, `{ error, error_description }` from the token endpoint. Quota errors (429,
 * `RESOURCE_EXHAUSTED`) are `rate_limited` with a wait that depends on the quota.
 */
export function mapGa4Error(httpStatus: number, text: string, retryAfterMs?: number): IntegrationError | null {
  type Body = { error?: unknown; error_description?: unknown } | null;
  let body: Body = null;
  try {
    body = JSON.parse(text) as Body;
  } catch {
    body = null;
  }
  if (body && typeof body.error === "string") {
    const desc = typeof body.error_description === "string" ? body.error_description : "";
    const code = body.error === "invalid_client" || body.error === "invalid_grant" || body.error === "unauthorized_client" ? "token_expired" : "invalid_request";
    return new IntegrationError(code, `Google sign-in refused: ${body.error}${desc ? ` (${desc})` : ""}`);
  }
  const err = body?.error && typeof body.error === "object" ? (body.error as { status?: string; message?: string; details?: { reason?: string }[] }) : null;
  const status = err?.status ?? "";
  const message = (err?.message ?? text).slice(0, 300);
  const reason = err?.details?.find((d) => d?.reason)?.reason ?? "";
  if (httpStatus === 429 || status === "RESOURCE_EXHAUSTED") return new IntegrationError("rate_limited", `GA4 quota exhausted: ${message}`, Math.max(retryAfterMs ?? 0, quotaWait(message)));
  if (httpStatus === 401 || status === "UNAUTHENTICATED") return new IntegrationError("token_expired", `GA4 authentication failed: ${message}`);
  if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) return new IntegrationError("permission", `The Google Analytics Data API is not enabled in the Cloud project: ${message}`);
  if (httpStatus === 403 || status === "PERMISSION_DENIED") return new IntegrationError("permission", `No access to the GA4 property: ${message}`);
  if (httpStatus === 404 || status === "NOT_FOUND") return new IntegrationError("not_found", `GA4 property not found: ${message}`);
  if (httpStatus >= 500) return new IntegrationError("network", `GA4 unavailable (HTTP ${httpStatus}): ${message}`, retryAfterMs);
  if (httpStatus >= 400) return new IntegrationError("invalid_request", `GA4 refused the request: ${message}`);
  return null;
}

interface RunReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
  metadata?: { timeZone?: string; currencyCode?: string };
  propertyQuota?: Ga4PropertyQuota;
}

/** The `runReport` body of the daily traffic report for a window and a page. */
export function ga4TrafficRequest(window: { since: string; until: string }, offset = 0, limit = GA4_PAGE_SIZE) {
  return {
    dateRanges: [{ startDate: window.since, endDate: window.until }],
    dimensions: GA4_TRAFFIC_DIMENSIONS.map((name) => ({ name })),
    metrics: GA4_TRAFFIC_METRICS.map((name) => ({ name })),
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: String(limit),
    offset: String(offset),
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

/** Rows of a `runReport` answer → normalised traffic rows, read by header name (never by position). */
export function mapGa4TrafficRows(res: RunReportResponse): NormalizedTrafficRow[] {
  const dims = (res.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (res.metricHeaders ?? []).map((h) => h.name);
  const d = (r: NonNullable<RunReportResponse["rows"]>[number], name: string) => {
    const i = dims.indexOf(name);
    const v = i >= 0 ? (r.dimensionValues?.[i]?.value ?? "").trim() : "";
    return v || TRAFFIC_NOT_SET;
  };
  const m = (r: NonNullable<RunReportResponse["rows"]>[number], name: string) => {
    const i = mets.indexOf(name);
    const n = i >= 0 ? Number(r.metricValues?.[i]?.value ?? 0) : 0;
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  return (res.rows ?? []).map((r) => {
    const landingPage = d(r, "landingPagePlusQueryString");
    return { date: ga4DateToIso(d(r, "date")), channelGroup: d(r, "sessionDefaultChannelGroup"), source: d(r, "sessionSource"), medium: d(r, "sessionMedium"), campaignName: d(r, "sessionCampaignName"), landingPage, landingPath: normalizeLandingPath(landingPage), sessions: m(r, "sessions"), totalUsers: m(r, "totalUsers"), engagedSessions: m(r, "engagedSessions"), addToCarts: m(r, "addToCarts") };
  });
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The signed JWT a service account exchanges for an access token (RS256, one hour). */
export function serviceAccountAssertion(sa: Ga4ServiceAccount, nowMs = Date.now(), scope = GA4_SCOPE): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri ?? GOOGLE_TOKEN_URI, iat, exp: iat + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(signature)}`;
}

/** Live GA4 adapter for one property. */
export class Ga4AnalyticsPlatform implements AnalyticsPlatform {
  readonly provider = "ga4";
  readonly http: HttpClient;
  /** The quota left after the last report, for the sync log. */
  lastQuota: Ga4PropertyQuota | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly propertyId: string;
  private readonly now: () => number;

  constructor(private readonly creds: Ga4Credentials, opts: HttpOptions & { propertyId: string; accessToken?: string; now?: () => number }) {
    // two quick retries only: an exhausted hourly quota does not come back in seconds
    this.http = new HttpClient({ maxRetries: 2, mapError: mapGa4Error, ...opts });
    const id = normalizeGa4PropertyId(opts.propertyId);
    if (!id) throw new IntegrationError("invalid_request", `Not a GA4 property id: ${opts.propertyId}`);
    this.propertyId = id;
    this.now = opts.now ?? Date.now;
    if (opts.accessToken) {
      this.accessToken = opts.accessToken;
      this.tokenExpiresAt = this.now() + HOUR;
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const body = this.creds.kind === "service_account"
      ? new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(this.creds.serviceAccount, this.now()) }).toString()
      : new URLSearchParams({ grant_type: "refresh_token", client_id: this.creds.clientId, client_secret: this.creds.clientSecret, refresh_token: this.creds.refreshToken }).toString();
    const uri = this.creds.kind === "service_account" ? (this.creds.serviceAccount.token_uri ?? GOOGLE_TOKEN_URI) : GOOGLE_TOKEN_URI;
    const res = await this.http.request<{ access_token?: string; expires_in?: number }>(uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!res.json?.access_token) throw new IntegrationError("token_expired", "Google returned no access token");
    this.accessToken = res.json.access_token;
    this.tokenExpiresAt = this.now() + (res.json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async call<T>(url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.http.request<T>(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json;
  }

  async runReport(body: unknown): Promise<RunReportResponse> {
    const res = await this.call<RunReportResponse>(`${GA4_DATA_API_BASE}/properties/${this.propertyId}:runReport`, body);
    this.lastQuota = res?.propertyQuota ?? null;
    return res ?? {};
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const until = new Date(this.now()).toISOString().slice(0, 10);
      const since = new Date(this.now() - 6 * 864e5).toISOString().slice(0, 10);
      await this.runReport({ dateRanges: [{ startDate: since, endDate: until }], metrics: [{ name: "sessions" }], limit: "1", returnPropertyQuota: true });
      // the property name needs the Admin API too; without it the id is enough
      const name = await this.call<{ displayName?: string }>(`${GA4_ADMIN_API_BASE}/properties/${this.propertyId}`).then((p) => p?.displayName ?? null).catch(() => null);
      return { ok: true, accountId: this.propertyId, accountName: name ?? `GA4 ${this.propertyId}`, scopes: [GA4_SCOPE] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof IntegrationError ? { errorCode: e.code } : {}) };
    }
  }

  /** Every property of every account the credentials can read (Admin API `accountSummaries`). */
  async listProperties(): Promise<AnalyticsProperty[]> {
    const out: AnalyticsProperty[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await this.call<{ accountSummaries?: { displayName?: string; propertySummaries?: { property?: string; displayName?: string }[] }[]; nextPageToken?: string }>(`${GA4_ADMIN_API_BASE}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      for (const a of res?.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) {
        const id = normalizeGa4PropertyId(p.property ?? "");
        if (id) out.push({ propertyId: id, displayName: p.displayName ?? id, accountName: a.displayName ?? null });
      }
      pageToken = res?.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  }

  /** Every page of the daily traffic report; stops with `rate_limited` before a call the property quota would refuse. */
  async fetchDailyTraffic(window: { since: string; until: string }): Promise<NormalizedTrafficRow[]> {
    const rows: NormalizedTrafficRow[] = [];
    for (let offset = 0; ; ) {
      const res = await this.runReport(ga4TrafficRequest(window, offset));
      const page = mapGa4TrafficRows(res);
      rows.push(...page);
      offset += page.length;
      if (!page.length || offset >= (res.rowCount ?? 0)) return rows;
      const quota = ga4QuotaError(res.propertyQuota);
      if (quota) throw quota;
    }
  }
}
export * from "./platform";
