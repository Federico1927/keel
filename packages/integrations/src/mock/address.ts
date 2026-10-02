import { normalizeAddress, validateAddressFormat } from "@keel/core";
import type { Address, AddressProvider, AddressSuggestion, AddressValidation, ConnectionTest } from "../types";

/** A few real-looking places per country so suggestions read naturally in the demo tenants. */
const PLACES: Record<string, { city: string; province: string | null; zip: string }[]> = {
  US: [{ city: "Austin", province: "TX", zip: "78701" }, { city: "Portland", province: "OR", zip: "97205" }, { city: "Brooklyn", province: "NY", zip: "11201" }, { city: "Denver", province: "CO", zip: "80202" }],
  IT: [{ city: "Milano", province: "MI", zip: "20121" }, { city: "Roma", province: "RM", zip: "00184" }, { city: "Torino", province: "TO", zip: "10121" }, { city: "Bologna", province: "BO", zip: "40121" }],
  ES: [{ city: "Madrid", province: "M", zip: "28013" }, { city: "Barcelona", province: "B", zip: "08001" }, { city: "Valencia", province: "V", zip: "46001" }],
  FR: [{ city: "Paris", province: null, zip: "75003" }, { city: "Lyon", province: null, zip: "69002" }, { city: "Lille", province: null, zip: "59000" }],
  DE: [{ city: "Berlin", province: null, zip: "10115" }, { city: "München", province: null, zip: "80331" }, { city: "Hamburg", province: null, zip: "20095" }],
  GB: [{ city: "London", province: null, zip: "EC1A 1BB" }, { city: "Manchester", province: null, zip: "M1 1AE" }, { city: "Leeds", province: null, zip: "LS1 4AP" }],
};

const titleCase = (s: string) => s.trim().replace(/\s+/g, " ").replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());

/**
 * Deterministic address provider: suggestions are the typed street in a few cities of the
 * country, validation is the format check from core plus a simulated "not found" for streets
 * containing "nowhere". No network.
 */
export class MockAddressProvider implements AddressProvider {
  readonly provider = "address-mock";
  readonly calls: { op: "autocomplete" | "validate"; input: unknown }[] = [];
  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, accountName: "Simulated address provider" };
  }
  async autocomplete(query: string, opts: { country: string | null; limit?: number }): Promise<AddressSuggestion[]> {
    this.calls.push({ op: "autocomplete", input: { query, country: opts.country } });
    const q = query.trim();
    if (q.length < 3) return [];
    const country = (opts.country ?? "US").toUpperCase();
    const places = PLACES[country] ?? [{ city: "Capital City", province: null, zip: "1000" }];
    const street = titleCase(/\d/.test(q) ? q : `${q} 1`);
    return places.slice(0, Math.max(1, Math.min(opts.limit ?? 3, 5))).map((p, i) => {
      const address: Address = { address1: street, address2: null, city: p.city, province: p.province, zip: p.zip, country };
      return { id: `mock-${country}-${i}`, label: `${street}, ${p.zip} ${p.city}${p.province ? ` ${p.province}` : ""}, ${country}`, address };
    });
  }
  async validate(address: Address): Promise<AddressValidation> {
    this.calls.push({ op: "validate", input: address });
    const normalized = normalizeAddress(address);
    const issues: AddressValidation["issues"] = validateAddressFormat(normalized);
    if (/nowhere/i.test(normalized.address1 ?? "")) issues.push({ field: "address1", code: "not_found" });
    return { valid: issues.length === 0, issues, normalized };
  }
}
