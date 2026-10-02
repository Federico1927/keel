import { MCP_DEFAULT_SCOPES, MCP_LIMITS, MCP_PII_ROLES, MCP_SCOPES, isMcpScope, type McpScope, type TenantRole } from "@hullwise/config";
import type { OrderStatus } from "./domain";

/**
 * Pure rules of the remote MCP server (#21): PII masking, input sanitising, scopes and the order
 * status changes an AI client may make by itself. No I/O; the services apply them.
 */

/* ---------- PII ---------- */

/** Full PII only when the tenant switched it on for MCP and the role may see it; masked otherwise. */
export function mcpPiiMode(role: TenantRole, tenantFullPii: boolean): "full" | "masked" {
  return tenantFullPii && MCP_PII_ROLES.includes(role) ? "full" : "masked";
}

/** `mario.rossi@example.com` → `m***@example.com`. Anything that is not an address → `•••`. */
export function maskEmailAddress(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "•••";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/** `+39 333 123 4567` → `•••4567`; fewer than 6 digits → `•••`. */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 6 ? `•••${digits.slice(-4)}` : "•••";
}

/** `Mario Rossi` → `Mario R.`; a single word keeps its initial only (`M.`). */
export function maskPersonName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "•••";
  if (parts.length === 1) return `${parts[0]![0]!.toUpperCase()}.`;
  return `${parts[0]} ${parts.slice(1).map((p) => `${p[0]!.toUpperCase()}.`).join(" ")}`;
}

const EMAIL_KEY = /email/i;
const PHONE_KEY = /phone|mobile/i;
/** Keys that hold a person's name (customer, recipient), never a product or campaign name. */
const PERSON_KEYS = new Set(["customerName", "firstName", "lastName", "fullName", "shippingName", "billingName", "recipientName", "contactName"]);
/** Street-level address parts; city, province and country stay readable (analytics need them). */
const STREET_KEYS = new Set(["address1", "address2", "street", "line1", "line2", "zip", "postalCode", "postcode", "addressKey", "nameZipKey", "ip", "ipAddress"]);
/** Objects that are addresses: their `name` is the recipient. */
const ADDRESS_OBJECT = /address$/i;
/** Free text written by people: emails and phone numbers inside it are masked too. */
const FREE_TEXT_KEYS = /^(note|notes|body|text|message|comment|reason|cancelReason|holdReason|customerNote)$/i;

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{7,}\d/g;

export interface MaskOptions {
  /** Extra keys (anywhere in the value) that hold a person's name for this tool. */
  nameKeys?: readonly string[];
}

/**
 * Masks PII in any JSON-like value, recursively: emails (`m***@domain`), phones (`•••1234`), person
 * names (`Mario R.`), street addresses and IPs (`•••`), and emails or phone numbers written inside
 * free text. Dates are left alone. Returns a new value; the input is not changed.
 */
export function maskPii<T>(value: T, opts: MaskOptions = {}): T {
  const nameKeys = new Set([...PERSON_KEYS, ...(opts.nameKeys ?? [])]);
  const walk = (v: unknown, key: string | null, inAddress: boolean): unknown => {
    if (v === null || v === undefined) return v;
    if (v instanceof Date) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key, inAddress));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      const address = key !== null && ADDRESS_OBJECT.test(key);
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k, address);
      return out;
    }
    if (typeof v !== "string" || key === null) return typeof v === "string" ? v.replace(EMAIL_IN_TEXT, maskEmailAddress) : v;
    if (EMAIL_KEY.test(key)) return v.includes("@") ? maskEmailAddress(v) : v ? "•••" : v;
    if (PHONE_KEY.test(key)) return v ? maskPhoneNumber(v) : v;
    if (nameKeys.has(key) || (inAddress && (key === "name" || key === "company"))) return v ? maskPersonName(v) : v;
    if (STREET_KEYS.has(key)) return v ? "•••" : v;
    if (FREE_TEXT_KEYS.test(key)) return v.replace(EMAIL_IN_TEXT, maskEmailAddress).replace(PHONE_IN_TEXT, (m) => maskPhoneNumber(m));
    return v.replace(EMAIL_IN_TEXT, maskEmailAddress);
  };
  return walk(value, null, false) as T;
}

/* ---------- input ---------- */

// zero-width, line-separator and bidi override characters are dropped with the C0 controls
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]", "g");

/** A search term from a model: no control characters or LIKE wildcards, one line, capped (80 by default). */
export function sanitizeSearch(input: unknown, max: number = MCP_LIMITS.searchMaxChars): string {
  if (typeof input !== "string") return "";
  return input.replace(CONTROL, "").replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Free text a tool writes (a note, a reason): no control characters except newlines, capped. */
export function sanitizeFreeText(input: unknown, max: number = MCP_LIMITS.textMaxChars): string {
  if (typeof input !== "string") return "";
  return input.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim();
}

/* ---------- scopes ---------- */

/** Parses a space-separated scope string (OAuth) or a list; unknown scopes are dropped and `read` is always included. */
export function parseMcpScopes(input: string | readonly string[] | null | undefined): McpScope[] {
  const raw = typeof input === "string" ? input.split(/[\s,]+/) : (input ?? []);
  const picked = new Set<McpScope>(MCP_DEFAULT_SCOPES);
  for (const s of raw) if (isMcpScope(s)) picked.add(s);
  return MCP_SCOPES.filter((s) => picked.has(s));
}

/** The scopes granted when the person narrows a request on the consent screen: never more than requested. */
export function narrowMcpScopes(requested: readonly McpScope[], chosen: readonly string[]): McpScope[] {
  const allowed = new Set(requested);
  return parseMcpScopes(chosen.filter((s) => allowed.has(s as McpScope)));
}

/* ---------- writes ---------- */

/**
 * Order status changes an AI client may make by itself: reversible review steps and holds on open
 * orders. Cancelling, refunding and anything the platform decides (shipped, delivered, returned)
 * is never a direct MCP write (cancellation is a proposal a person approves).
 */
export const MCP_ORDER_TRANSITIONS: Partial<Record<OrderStatus, readonly OrderStatus[]>> = {
  new: ["pending_review", "confirmed", "on_hold"],
  pending_review: ["new", "confirmed", "on_hold"],
  confirmed: ["pending_review", "on_hold"],
  fulfilling: ["on_hold"],
  on_hold: ["new", "pending_review", "confirmed"],
};

export function canMcpSetOrderStatus(from: string, to: string): boolean {
  return (MCP_ORDER_TRANSITIONS[from as OrderStatus] ?? []).includes(to as OrderStatus);
}
