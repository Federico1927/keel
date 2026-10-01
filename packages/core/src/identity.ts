import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** E.164 or null. Default country from the tenant; never hardcoded. */
export function normalizePhone(raw: string | null | undefined, defaultCountry: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 5) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, defaultCountry.toUpperCase() as CountryCode);
    if (!parsed || !parsed.isPossible()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return n.length ? n : null;
}

export interface AddressLike {
  address1?: string | null;
  zip?: string | null;
  city?: string | null;
}

/** `address1|zip|city` lowered and collapsed; null when too short to be meaningful. */
export function addressKey(a: AddressLike | null | undefined): string | null {
  if (!a) return null;
  const a1 = (a.address1 ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const zip = (a.zip ?? "").trim().toLowerCase();
  const city = (a.city ?? "").trim().toLowerCase();
  if (a1.length < 5 || !zip) return null;
  return `${a1}|${zip}|${city}`;
}

export function nameZipKey(name: string | null | undefined, zip: string | null | undefined): string | null {
  const n = normalizeName(name);
  const z = (zip ?? "").trim().toLowerCase();
  if (!n || !z) return null;
  return `${n}|${z}`;
}
