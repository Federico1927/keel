import { API_LIMITS, API_SCOPES, WEBHOOK_LIMITS, WEBHOOK_RETRY_SCHEDULE_SECONDS, isApiScope, type ApiScope } from "@hullwise/config";

/**
 * Pure rules of the public REST API and outgoing webhooks (#81): opaque cursors, page sizes, error
 * codes, webhook signatures (the HMAC itself is injected: no crypto import here), the retry schedule
 * and the webhook URL guard (syntax and IP classes; DNS resolution happens in the services).
 */

/* ---------- errors ---------- */

/** Stable error codes of `{ error: { code, message } }` and their HTTP status. */
export const API_ERRORS = {
  unauthorized: 401,
  invalid_token: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_available: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  idempotency_key_reused: 422,
  invalid_request: 400,
  invalid_cursor: 400,
  payload_too_large: 413,
  unprocessable: 422,
  rate_limited: 429,
  internal_error: 500,
} as const;
export type ApiErrorCode = keyof typeof API_ERRORS;

/* ---------- scopes ---------- */

/** API scopes of a token's scope list: unknown values (MCP scopes, typos) are dropped, nothing is implied. */
export function parseApiScopes(input: string | readonly string[] | null | undefined): ApiScope[] {
  const raw = typeof input === "string" ? input.split(/[\s,]+/) : (input ?? []);
  const picked = new Set(raw.filter(isApiScope));
  return API_SCOPES.filter((s) => picked.has(s));
}

/** Full PII through the API: the token carries `pii:read`, the role may see PII and the tenant switched it on. */
export function apiPiiMode(scopes: readonly ApiScope[], roleMaySeePii: boolean, tenantFullPii: boolean): "full" | "masked" {
  return scopes.includes("pii:read") && roleMaySeePii && tenantFullPii ? "full" : "masked";
}

/* ---------- pagination ---------- */

/** `limit` query value → 1..max (default when missing); null when it is not a positive integer. */
export function parseApiLimit(raw: string | null | undefined, max: number = API_LIMITS.maxPageSize, fallback: number = API_LIMITS.defaultPageSize): number | null {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? Math.min(n, max) : null;
}

export type CursorValue = string | number | null;

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function fromBase64Url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/**
 * An opaque keyset cursor: the list it belongs to and the sort values of the last row returned.
 * It is not signed: a forged cursor only moves the position inside the token's own tenant (every
 * query runs under RLS), so it cannot widen access.
 */
export function encodeCursor(list: string, values: readonly CursorValue[]): string {
  return toBase64Url(JSON.stringify({ v: 1, l: list, k: values }));
}

/** The sort values of a cursor of this list, or null when it is malformed or belongs to another list. */
export function decodeCursor(list: string, cursor: string | null | undefined, arity: number): CursorValue[] | null {
  if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(cursor)) as { v?: unknown; l?: unknown; k?: unknown };
    if (parsed.v !== 1 || parsed.l !== list || !Array.isArray(parsed.k) || parsed.k.length !== arity) return null;
    if (!parsed.k.every((x) => x === null || typeof x === "string" || (typeof x === "number" && Number.isFinite(x)))) return null;
    return parsed.k as CursorValue[];
  } catch {
    return null;
  }
}

/** One page from `limit + 1` rows: the extra row only says there is a next page. */
export function pageOf<T>(rows: readonly T[], limit: number, cursorOf: (row: T) => string): { data: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  return { data, hasMore, nextCursor: hasMore && data.length ? cursorOf(data[data.length - 1]!) : null };
}

/* ---------- webhook signatures ---------- */

/** What is signed: `<unix seconds>.<raw body>`. */
export function webhookSignedContent(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

/** `t=<unix seconds>,v1=<hex>[,v1=<hex>]`: one `v1` per active secret (two during a rotation). */
export function formatWebhookSignature(timestamp: number, hexDigests: readonly string[]): string {
  return [`t=${timestamp}`, ...hexDigests.map((h) => `v1=${h}`)].join(",");
}

export function parseWebhookSignature(header: string | null | undefined): { timestamp: number; signatures: string[] } | null {
  if (!header || header.length > 1000) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  return timestamp !== null && signatures.length ? { timestamp, signatures } : null;
}

/** Constant-time comparison of two hex strings of the same length. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Receiver-side check: the header parses, the timestamp is within the tolerance and one `v1` equals
 * HMAC-SHA256(secret, `<t>.<body>`) as computed by `hmacHex` (the caller's crypto).
 */
export function verifyWebhookSignature(input: { header: string | null | undefined; body: string; now: Date; hmacHex: (content: string) => string; toleranceSeconds?: number }): { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" } {
  const parsed = parseWebhookSignature(input.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const tolerance = input.toleranceSeconds ?? WEBHOOK_LIMITS.signatureToleranceSeconds;
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - parsed.timestamp) > tolerance) return { ok: false, reason: "stale" };
  const expected = input.hmacHex(webhookSignedContent(parsed.timestamp, input.body));
  return parsed.signatures.some((s) => sameHex(s, expected)) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/* ---------- retries ---------- */

/** Total attempts of a delivery: the first one plus one per scheduled retry. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_SECONDS.length + 1;

/** Seconds to wait after the `attempts`-th failed attempt, or null when the delivery is dead. */
export function webhookRetryDelaySeconds(attempts: number): number | null {
  if (!Number.isInteger(attempts) || attempts < 1) return WEBHOOK_RETRY_SCHEDULE_SECONDS[0];
  return WEBHOOK_RETRY_SCHEDULE_SECONDS[attempts - 1] ?? null;
}

/** A 2xx answer is a delivery; anything else (any other status, a timeout, a refused connection) is retried. */
export function isWebhookSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/* ---------- URL guard ---------- */

export interface WebhookUrlPolicy {
  /** Plain http is refused unless loopback is allowed (test receivers only). */
  allowLoopback: boolean;
}

export type WebhookUrlProblem = "invalid_url" | "scheme" | "credentials" | "fragment" | "host" | "private_address" | "port";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Parts(ip: string): number[] | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Expands an IPv6 literal to eight 16-bit groups (an embedded IPv4 tail included), or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4Parts(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some((g) => Number.isNaN(g))) return null;
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill(0), ...rest];
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 ? groups : null;
}

export type IpClass = "public" | "loopback" | "private" | "link_local" | "reserved" | "invalid";

function classifyV4(p: number[]): IpClass {
  const [a, b] = [p[0]!, p[1]!];
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  // 169.254.0.0/16 holds the cloud metadata endpoints (169.254.169.254)
  if (a === 169 && b === 254) return "link_local";
  if (a === 0 || a >= 224 || (a === 192 && b === 0 && p[2] === 0) || (a === 192 && b === 0 && p[2] === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && p[2] === 100) || (a === 203 && b === 0 && p[2] === 113)) return "reserved";
  return "public";
}

/** The class of an IP literal (v4, v6, IPv4-mapped v6). Anything that is not `public` is refused for webhooks. */
export function classifyIp(ip: string): IpClass {
  const v4 = ipv4Parts(ip);
  if (v4) return classifyV4(v4);
  const g = ipv6Groups(ip);
  if (!g) return "invalid";
  if (g.every((x) => x === 0)) return "reserved";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address
  const embedsV4 = (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedsV4) return classifyV4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local (fd00:ec2::254 metadata included)
  if ((g[0]! & 0xffc0) === 0xfe80) return "link_local";
  if ((g[0]! & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0x0db8)) return "reserved";
  return "public";
}

/** Whether a resolved address may receive a webhook under the policy. */
export function isAllowedWebhookAddress(ip: string, policy: WebhookUrlPolicy): boolean {
  const c = classifyIp(ip);
  return c === "public" || (c === "loopback" && policy.allowLoopback);
}

/**
 * Static checks of a webhook URL before any DNS lookup: https (http only to loopback when the test
 * policy allows it), no credentials or fragment, a host name or a public IP literal, a sane port.
 * The resolved addresses are checked again at every delivery (DNS can change).
 */
export function checkWebhookUrl(raw: string, policy: WebhookUrlPolicy): { ok: true; url: URL } | { ok: false; problem: WebhookUrlProblem } {
  if (typeof raw !== "string" || raw.length > 2000) return { ok: false, problem: "invalid_url" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: "invalid_url" };
  }
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  if (url.hash) return { ok: false, problem: "fragment" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { ok: false, problem: "host" };
  const literal = ipv4Parts(host) !== null || host.includes(":");
  const loopbackName = host === "localhost" || host.endsWith(".localhost");
  const isLoopback = loopbackName || (literal && classifyIp(host) === "loopback");
  if (url.protocol === "http:") {
    if (!(policy.allowLoopback && isLoopback)) return { ok: false, problem: "scheme" };
  } else if (url.protocol !== "https:") return { ok: false, problem: "scheme" };
  if (literal) {
    if (!isAllowedWebhookAddress(host, policy)) return { ok: false, problem: "private_address" };
  } else {
    if (loopbackName && !policy.allowLoopback) return { ok: false, problem: "private_address" };
    // a single label (intranet name) or an internal suffix never resolves to a public receiver
    if (!loopbackName && (!host.includes(".") || /\.(internal|local|lan|home|corp|intranet)$/.test(host))) return { ok: false, problem: "host" };
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) return { ok: false, problem: "port" };
  return { ok: true, url };
}
