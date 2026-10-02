import { createHash } from "node:crypto";
import { HttpClient, type HttpOptions } from "./http";
import { META_API_VERSION, mapMetaError, type MetaCredentials } from "./meta";
import { GoogleAdsPlatform, type GoogleAdsCredentials } from "./google";
import { FailureScript } from "./mock/failures";

/**
 * Server-side conversions (Meta Conversions API, Google Ads click conversions with user
 * identifiers). Personal fields are normalised and SHA-256 hashed before they leave Hullwise and
 * before they are stored in the delivery log; only click ids, cookie ids, IP and user agent
 * travel in clear, as both platforms require.
 */
export const CONVERSION_PROVIDERS = ["meta", "google"] as const;
export type ConversionProvider = (typeof CONVERSION_PROVIDERS)[number];

export interface ConversionUserData {
  email?: string | null;
  phoneE164?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  zip?: string | null;
  country?: string | null;
  externalId?: string | null;
}

export interface HashedUserData {
  em?: string;
  ph?: string;
  /** Phone as Google wants it (E.164 with "+") before hashing. */
  phE164?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  zp?: string;
  country?: string;
  externalId?: string;
}

export interface ConversionEvent {
  /** Stable per order: the same id from the pixel and from the server lets the platform drop the duplicate. */
  eventId: string;
  eventName: "Purchase";
  eventTime: Date;
  orderExternalId: string;
  valueMinor: number;
  currency: string;
  user: HashedUserData;
  clickIds: { fbclid?: string; gclid?: string; gbraid?: string; wbraid?: string };
  fbp?: string | null;
  fbc?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  sourceUrl?: string | null;
}

export interface ConversionResult {
  eventId: string;
  ok: boolean;
  /** Not sent because the event lacks what the platform needs (e.g. no click id nor identifier for Google). */
  skipped?: boolean;
  error?: string;
}

export interface ConversionSink {
  readonly provider: ConversionProvider;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  send(events: ConversionEvent[]): Promise<ConversionResult[]>;
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const lowerTrim = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Meta's normalisation rules: lower case, no spaces in city and zip, two-letter country, phone digits with country code. */
export function hashUserData(u: ConversionUserData): HashedUserData {
  const out: HashedUserData = {};
  const email = lowerTrim(u.email);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.em = sha256(email);
  if (u.phoneE164 && /^\+\d{6,15}$/.test(u.phoneE164)) {
    out.ph = sha256(u.phoneE164.slice(1));
    out.phE164 = sha256(u.phoneE164);
  }
  const fn = lowerTrim(u.firstName);
  if (fn) out.fn = sha256(fn);
  const ln = lowerTrim(u.lastName);
  if (ln) out.ln = sha256(ln);
  const ct = lowerTrim(u.city).replace(/[^\p{L}]/gu, "");
  if (ct) out.ct = sha256(ct);
  const zp = lowerTrim(u.zip).replace(/\s+/g, "");
  if (zp) out.zp = sha256(zp);
  const country = lowerTrim(u.country);
  if (/^[a-z]{2}$/.test(country)) out.country = sha256(country);
  if (u.externalId) out.externalId = sha256(u.externalId);
  return out;
}

/** `fbc` cookie value rebuilt from a click id when the browser did not keep one: fb.1.<ms>.<fbclid>. */
export function fbcFromClickId(fbclid: string, clickedAt: Date): string {
  return `fb.1.${clickedAt.getTime()}.${fbclid}`;
}

/* ---------- Meta Conversions API ---------- */

export function metaEventPayload(e: ConversionEvent): Record<string, unknown> {
  const user: Record<string, unknown> = {};
  for (const k of ["em", "ph", "fn", "ln", "ct", "zp", "country"] as const) if (e.user[k]) user[k] = [e.user[k]];
  if (e.user.externalId) user.external_id = [e.user.externalId];
  if (e.clientIp) user.client_ip_address = e.clientIp;
  if (e.userAgent) user.client_user_agent = e.userAgent;
  if (e.fbc) user.fbc = e.fbc;
  if (e.fbp) user.fbp = e.fbp;
  return {
    event_name: e.eventName,
    event_time: Math.floor(e.eventTime.getTime() / 1000),
    event_id: e.eventId,
    action_source: "website",
    ...(e.sourceUrl ? { event_source_url: e.sourceUrl } : {}),
    user_data: user,
    custom_data: { currency: e.currency, value: e.valueMinor / 100, order_id: e.orderExternalId },
  };
}

/** POST /{dataset_id}/events. One request per batch; Meta accepts up to 1000 events and rejects the whole batch on a malformed one. */
export class MetaConversionsSink implements ConversionSink {
  readonly provider = "meta" as const;
  readonly http: HttpClient;
  private readonly base: string;
  constructor(private readonly creds: MetaCredentials, private readonly datasetId: string, opts: HttpOptions & { apiVersion?: string; testEventCode?: string | null } = {}) {
    this.http = new HttpClient(opts);
    this.base = `https://graph.facebook.com/${opts.apiVersion ?? META_API_VERSION}`;
    this.testEventCode = opts.testEventCode ?? null;
  }
  private readonly testEventCode: string | null;
  async testConnection() {
    try {
      const res = await this.http.request<{ id?: string; error?: { message: string; code: number } }>(`${this.base}/${this.datasetId}?fields=id,name&access_token=${encodeURIComponent(this.creds.accessToken)}`);
      if (res.json.error) throw mapMetaError(res.json.error);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  async send(events: ConversionEvent[]): Promise<ConversionResult[]> {
    if (!events.length) return [];
    const body: Record<string, unknown> = { data: events.map(metaEventPayload), access_token: this.creds.accessToken };
    if (this.testEventCode) body.test_event_code = this.testEventCode;
    const res = await this.http.request<{ events_received?: number; error?: { message: string; code: number } }>(`${this.base}/${this.datasetId}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.json.error) throw mapMetaError(res.json.error);
    return events.map((e) => ({ eventId: e.eventId, ok: true }));
  }
}

/* ---------- Google Ads click conversions ---------- */

function googleDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

/** Google needs a click id or at least one hashed identifier; null when the event has neither. */
export function googleConversionPayload(e: ConversionEvent, conversionAction: string): Record<string, unknown> | null {
  const identifiers: Record<string, string>[] = [];
  if (e.user.em) identifiers.push({ hashedEmail: e.user.em });
  if (e.user.phE164) identifiers.push({ hashedPhoneNumber: e.user.phE164 });
  const click = e.clickIds.gclid ? { gclid: e.clickIds.gclid } : e.clickIds.gbraid ? { gbraid: e.clickIds.gbraid } : e.clickIds.wbraid ? { wbraid: e.clickIds.wbraid } : null;
  if (!click && !identifiers.length) return null;
  return { ...(click ?? {}), conversionAction, conversionDateTime: googleDateTime(e.eventTime), conversionValue: e.valueMinor / 100, currencyCode: e.currency, orderId: e.orderExternalId, ...(identifiers.length ? { userIdentifiers: identifiers } : {}) };
}

/** customers/{id}:uploadClickConversions with partial failure, so one bad row does not drop the batch. */
export class GoogleConversionsSink implements ConversionSink {
  readonly provider = "google" as const;
  readonly ads: GoogleAdsPlatform;
  constructor(creds: GoogleAdsCredentials, private readonly conversionActionId: string, opts: HttpOptions & { apiVersion?: string; accessToken?: string } = {}) {
    this.ads = new GoogleAdsPlatform(creds, opts);
  }
  get http() {
    return this.ads.http;
  }
  async testConnection() {
    const t = await this.ads.testConnection();
    return t.ok ? { ok: true } : { ok: false, error: t.error };
  }
  async send(events: ConversionEvent[]): Promise<ConversionResult[]> {
    const action = `${this.ads.customerResource()}/conversionActions/${this.conversionActionId}`;
    const rows: { e: ConversionEvent; payload: Record<string, unknown> }[] = [];
    const results = new Map<string, ConversionResult>();
    for (const e of events) {
      const payload = googleConversionPayload(e, action);
      if (payload) rows.push({ e, payload });
      else results.set(e.eventId, { eventId: e.eventId, ok: false, skipped: true, error: "no click id or identifier" });
    }
    if (rows.length) {
      const res = await this.ads.post<{ partialFailureError?: { message: string; details?: { errors?: { location?: { fieldPathElements?: { fieldName: string; index?: number }[] }; message: string }[] }[] } }>(":uploadClickConversions", { conversions: rows.map((r) => r.payload), partialFailure: true });
      const failed = new Map<number, string>();
      for (const d of res.partialFailureError?.details ?? []) {
        for (const err of d.errors ?? []) {
          const idx = err.location?.fieldPathElements?.find((f) => f.fieldName === "conversions")?.index;
          if (idx !== undefined) failed.set(idx, err.message);
        }
      }
      rows.forEach((r, i) => results.set(r.e.eventId, failed.has(i) ? { eventId: r.e.eventId, ok: false, error: failed.get(i) } : { eventId: r.e.eventId, ok: true }));
    }
    return events.map((e) => results.get(e.eventId)!);
  }
}

/* ---------- mock ---------- */

export class MockConversionSink implements ConversionSink {
  readonly failures = new FailureScript();
  readonly received: ConversionEvent[] = [];
  constructor(readonly provider: ConversionProvider) {}
  async testConnection() {
    return { ok: true };
  }
  async send(events: ConversionEvent[]): Promise<ConversionResult[]> {
    this.failures.check();
    return events.map((e) => {
      if (this.provider === "google" && !googleConversionPayload(e, "mock")) return { eventId: e.eventId, ok: false, skipped: true, error: "no click id or identifier" };
      this.received.push(e);
      return { eventId: e.eventId, ok: true };
    });
  }
}

