import { createHash } from "node:crypto";
import type { AudienceMatchKeys, AudienceMember, AudienceProvider } from "./types";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Lower-case, trimmed email; null when it is not an address. */
export function normalizeMatchEmail(email: string | null): string | null {
  const e = email?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * Identifiers a destination matches on. Ad platforms receive SHA-256 hashes of normalised
 * values, never the values themselves: Meta wants phone digits with country code and no "+",
 * Google wants E.164 with "+" (both to verify against the current API docs when going live).
 * Email tools receive the plain email and names, which is what they store anyway.
 * Returns null when the customer has nothing the destination can match.
 */
export function audienceMatchKeys(provider: AudienceProvider, m: AudienceMember): AudienceMatchKeys | null {
  const email = normalizeMatchEmail(m.email);
  const phone = m.phoneE164 && /^\+\d{6,15}$/.test(m.phoneE164) ? m.phoneE164 : null;
  const keys: Record<string, string> = {};
  if (provider === "email_tool") {
    if (!email) return null;
    keys.email = email;
    if (m.firstName) keys.first_name = m.firstName;
    if (m.lastName) keys.last_name = m.lastName;
    if (m.country) keys.country = m.country;
    return { customerId: m.customerId, keys };
  }
  if (email) keys.email_sha256 = sha256(email);
  if (phone) keys.phone_sha256 = sha256(provider === "meta_custom_audience" ? phone.slice(1) : phone);
  if (m.country) keys.country = m.country.toLowerCase();
  return keys.email_sha256 || keys.phone_sha256 ? { customerId: m.customerId, keys } : null;
}
