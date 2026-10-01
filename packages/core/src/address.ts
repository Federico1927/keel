/**
 * Format checks for a postal address, shared by the address provider mock and the order-edit
 * service. Not a deliverability check: a live provider (issue #7) answers that. Countries without
 * a known pattern only need the required fields.
 */
export interface PostalAddress {
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

export type AddressIssueCode = "required" | "invalid_zip" | "invalid_country";
export interface AddressIssue {
  field: "name" | "address1" | "city" | "zip" | "country" | "province";
  code: AddressIssueCode;
}

/** Postal code patterns by ISO country (upper case, spaces allowed where the country uses them). */
export const POSTAL_CODE_PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^\d{4}$/,
  AU: /^\d{4}$/,
  BE: /^\d{4}$/,
  CA: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/,
  CH: /^\d{4}$/,
  DE: /^\d{5}$/,
  DK: /^\d{4}$/,
  ES: /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/,
  FR: /^\d{5}$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/,
  IE: /^[A-Z]\d[\dW] ?[A-Z\d]{4}$/,
  IT: /^\d{5}$/,
  NL: /^\d{4} ?[A-Z]{2}$/,
  PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/,
  SE: /^\d{3} ?\d{2}$/,
  US: /^\d{5}(-\d{4})?$/,
};

/** Countries whose addresses need a province / state code. */
const PROVINCE_REQUIRED = new Set(["US", "CA", "AU"]);

export function normalizeZip(zip: string | null | undefined): string {
  return (zip ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Format issues of an address; empty when it is complete and well formed. */
export function validateAddressFormat(a: PostalAddress | null | undefined): AddressIssue[] {
  const issues: AddressIssue[] = [];
  const has = (v: string | null | undefined) => Boolean(v && v.trim());
  if (!has(a?.name)) issues.push({ field: "name", code: "required" });
  if (!has(a?.address1)) issues.push({ field: "address1", code: "required" });
  if (!has(a?.city)) issues.push({ field: "city", code: "required" });
  const country = (a?.country ?? "").trim().toUpperCase();
  if (!country) issues.push({ field: "country", code: "required" });
  else if (!/^[A-Z]{2}$/.test(country)) issues.push({ field: "country", code: "invalid_country" });
  const zip = normalizeZip(a?.zip);
  if (!zip) issues.push({ field: "zip", code: "required" });
  else if (POSTAL_CODE_PATTERNS[country] && !POSTAL_CODE_PATTERNS[country]!.test(zip)) issues.push({ field: "zip", code: "invalid_zip" });
  if (PROVINCE_REQUIRED.has(country) && !has(a?.province)) issues.push({ field: "province", code: "required" });
  return issues;
}

/** Trimmed copy with upper-case country and postal code; empty strings become null. */
export function normalizeAddress<T extends PostalAddress>(a: T): T {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim().replace(/\s+/g, " ") : null);
  return { ...a, name: clean(a.name), address1: clean(a.address1), address2: clean(a.address2), city: clean(a.city), province: clean(a.province), zip: normalizeZip(a.zip) || null, country: clean(a.country)?.toUpperCase() ?? null, phone: clean(a.phone) };
}
