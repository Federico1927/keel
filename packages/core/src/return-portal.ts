import { z } from "zod";
import { PAYMENT_METHODS } from "./tenant-settings";
import { RETURN_RESOLUTIONS } from "./domain";
import { normalizeEmail } from "./identity";

/**
 * Configuration of the public return portal of one tenant. Everything the customer sees is
 * configurable: texts per language, logo, colour, which resolutions are offered, extra fields,
 * when bank details are asked for (e.g. orders paid on delivery or by bank transfer).
 */

const localized = z.record(z.string().min(2).max(5), z.string().max(4000)).default({});

export const PORTAL_FIELD_TYPES = ["text", "textarea", "select", "checkbox"] as const;

export const portalFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  type: z.enum(PORTAL_FIELD_TYPES),
  label: localized,
  required: z.boolean().default(false),
  /** For `select`: option values; labels per language in `optionLabels[value]`. */
  options: z.array(z.string().max(80)).max(30).default([]),
  optionLabels: z.record(z.string(), localized).default({}),
});
export type PortalField = z.infer<typeof portalFieldSchema>;

export const returnPortalConfigSchema = z.object({
  enabled: z.boolean().default(false),
  logoUrl: z.string().url().max(500).nullable().default(null),
  /** Brand colour as #rrggbb. */
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1f4e79"),
  title: localized,
  intro: localized,
  successMessage: localized,
  /** Shipping instructions shown after submission (address, how to pack). */
  instructions: localized,
  policyUrl: z.string().url().max(500).nullable().default(null),
  resolutions: z.array(z.enum(RETURN_RESOLUTIONS)).min(1).default(["refund", "exchange", "voucher"]),
  /** Payment methods for which a refund needs the customer's bank details (account holder + IBAN). */
  bankDetailsFor: z.array(z.enum(PAYMENT_METHODS)).default([]),
  /** Ask for the customer's phone as a second key instead of the email. */
  lookupBy: z.enum(["email", "email_or_phone"]).default("email"),
  fields: z.array(portalFieldSchema).max(15).default([]),
  /** Reason codes offered on the portal; empty = all active reasons. */
  reasonCodes: z.array(z.string().max(40)).default([]),
  /** Show the order's status page link to the customer after submission. */
  showStatusPage: z.boolean().default(true),
  /** Ask first whether the parcel was already shipped; "not yet" shows the instructions before the form. */
  askShippedFirst: z.boolean().default(true),
  /** Return shipment tracking code asked to the customer. */
  tracking: z.object({ mode: z.enum(["off", "optional", "required"]).default("optional"), carriers: z.array(z.string().max(40)).max(15).default([]) }).default({ mode: "optional", carriers: [] }),
  /** Product photos (stored compressed, max 1.5 MB each). */
  photos: z.object({ mode: z.enum(["off", "optional", "required"]).default("off"), max: z.number().int().min(1).max(5).default(3) }).default({ mode: "off", max: 3 }),
  /** The customer must describe the wanted size/product when choosing an exchange. */
  exchangeNoteRequired: z.boolean().default(true),
  /** Final confirmation checkbox text; empty = no checkbox. */
  confirmText: localized,
  supportEmail: z.string().email().max(200).nullable().default(null),
});
export type ReturnPortalConfig = z.infer<typeof returnPortalConfigSchema>;

export function parsePortalConfig(raw: unknown): ReturnPortalConfig {
  const r = returnPortalConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : returnPortalConfigSchema.parse({});
}

/** Text in the requested language, else the tenant default, else English, else any. */
export function pickLocalized(map: Record<string, string> | undefined, locale: string, fallbackLocale: string): string {
  if (!map) return "";
  return map[locale] || map[fallbackLocale] || map.en || Object.values(map).find(Boolean) || "";
}

/** Validates the answers to the custom fields; returns the cleaned answers or the keys in error. */
export function validatePortalAnswers(fields: readonly PortalField[], answers: Record<string, unknown>): { ok: true; values: Record<string, string | boolean> } | { ok: false; errors: string[] } {
  const values: Record<string, string | boolean> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const raw = answers[f.key];
    if (f.type === "checkbox") {
      const v = raw === true || raw === "on" || raw === "true";
      if (f.required && !v) errors.push(f.key);
      values[f.key] = v;
      continue;
    }
    const v = typeof raw === "string" ? raw.trim().slice(0, f.type === "textarea" ? 2000 : 200) : "";
    if (f.required && !v) errors.push(f.key);
    else if (f.type === "select" && v && !f.options.includes(v)) errors.push(f.key);
    else if (v) values[f.key] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

/** IBAN check (ISO 13616 mod 97). Spaces are ignored. */
export function isValidIban(input: string): boolean {
  const iban = input.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function needsBankDetails(config: ReturnPortalConfig, paymentMethod: string, resolution: string): boolean {
  return resolution === "refund" && (config.bankDetailsFor as readonly string[]).includes(paymentMethod);
}

/**
 * Order lookup key match: the order name with or without prefix and "#", and the email
 * (normalized) or the phone (digits, last 9 compared to tolerate a missing country code).
 */
export function matchesOrderLookup(order: { name: string; email: string | null; phone: string | null }, input: { orderNumber: string; contact: string }, prefix: string, lookupBy: ReturnPortalConfig["lookupBy"]): boolean {
  const clean = (s: string) => s.trim().replace(/^#/, "").toUpperCase();
  const wanted = clean(input.orderNumber);
  const name = clean(order.name);
  const bare = prefix ? name.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toUpperCase()}`), "") : name;
  if (!wanted || (wanted !== name && wanted !== bare && `${prefix.toUpperCase()}${wanted}` !== name)) return false;
  const contact = input.contact.trim();
  if (!contact) return false;
  if (contact.includes("@")) return Boolean(order.email) && normalizeEmail(order.email!) === normalizeEmail(contact);
  if (lookupBy !== "email_or_phone" || !order.phone) return false;
  const digits = (s: string) => s.replace(/\D+/g, "");
  const a = digits(order.phone);
  const b = digits(contact);
  return b.length >= 8 && a.slice(-9) === b.slice(-9);
}

/** Fixed-window limiter decision: allowed when fewer than `max` attempts in the current window. */
export function rateLimitDecision(state: { windowStart: Date; count: number } | null, now: Date, windowSeconds: number, max: number): { allowed: boolean; windowStart: Date; count: number; retryAfterSeconds: number } {
  const fresh = !state || now.getTime() - state.windowStart.getTime() >= windowSeconds * 1000;
  const windowStart = fresh ? now : state!.windowStart;
  const count = (fresh ? 0 : state!.count) + 1;
  const allowed = count <= max;
  const retryAfterSeconds = allowed ? 0 : Math.ceil((windowStart.getTime() + windowSeconds * 1000 - now.getTime()) / 1000);
  return { allowed, windowStart, count, retryAfterSeconds };
}

/** Tracking code as carriers print it: no spaces or dots, upper case, 6–40 of A–Z 0–9 and dashes. */
export function normalizeTrackingCode(raw: string): string | null {
  const v = raw.replace(/[\s.]+/g, "").toUpperCase();
  return /^[A-Z0-9-]{6,40}$/.test(v) ? v : null;
}

/**
 * Amount proposed for a return: the net value of the returned units, less the return shipping
 * cost when the reason puts the fault on the customer (never below zero).
 */
export function proposedReturnAmount(lines: readonly { quantity: number; unitNetMinor: number }[], fault: string, returnShippingCostMinor: number): { goodsMinor: number; deductionMinor: number; proposedMinor: number } {
  const goods = lines.reduce((s, l) => s + l.quantity * l.unitNetMinor, 0);
  const deduction = fault === "customer" ? Math.min(goods, Math.max(0, returnShippingCostMinor)) : 0;
  return { goodsMinor: goods, deductionMinor: deduction, proposedMinor: goods - deduction };
}
