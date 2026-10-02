import { normalizeAddress, validateAddressFormat } from "@hullwise/core";
import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError, type Address, type AddressProvider, type AddressSuggestion, type AddressValidation, type ConnectionTest } from "../types";

/**
 * Live address provider on Google Maps Platform (issue #7): validation with the Address
 * Validation API, autocomplete with Places API (New) Autocomplete plus Place Details for the
 * structured address of each suggestion. One API key per store (the store's own Google Cloud
 * project and billing), sent in the `X-Goog-Api-Key` header, never in the URL. Tests run on
 * recorded responses through an injected fetch; nothing here is called in mock mode.
 */
export interface GoogleAddressCredentials {
  apiKey: string;
}

export const GOOGLE_ADDRESS_ENDPOINTS = {
  validate: "https://addressvalidation.googleapis.com/v1:validateAddress",
  autocomplete: "https://places.googleapis.com/v1/places:autocomplete",
  details: "https://places.googleapis.com/v1/places/",
} as const;

/** The two APIs to enable on the store's Google Cloud project (the guide lists them). */
export const GOOGLE_ADDRESS_APIS = ["addressvalidation.googleapis.com", "places.googleapis.com"] as const;

/** Countries that write the house number before the street. */
const NUMBER_FIRST = new Set(["US", "CA", "GB", "IE", "AU", "NZ", "FR", "ZA"]);
/** Countries whose province is the second administrative level (Italian provinces, Spanish provinces). */
const PROVINCE_LEVEL_2 = new Set(["IT", "ES"]);
/** Below route level Google could not place the street: Hullwise reports the street as not found. */
const COARSE_GRANULARITY = new Set(["GRANULARITY_UNSPECIFIED", "OTHER", "ADMINISTRATIVE_AREA", "LOCALITY", "SUB_LOCALITY"]);

type Field = AddressValidation["issues"][number]["field"];
const FIELD_OF: Record<string, Field> = {
  street_number: "address1",
  route: "address1",
  premise: "address1",
  locality: "city",
  postal_town: "city",
  sublocality: "city",
  administrative_area_level_3: "city",
  postal_code: "zip",
  administrative_area_level_1: "province",
  administrative_area_level_2: "province",
  country: "country",
};
/** Missing components that make an address undeliverable; others (sub-premise, a second admin level) are optional. */
const REQUIRED_COMPONENTS = new Set(["street_number", "route", "locality", "postal_town", "postal_code", "country"]);

interface ValidateResponse {
  result?: {
    verdict?: { inputGranularity?: string; validationGranularity?: string; geocodeGranularity?: string; addressComplete?: boolean; hasUnconfirmedComponents?: boolean; hasInferredComponents?: boolean; hasReplacedComponents?: boolean };
    address?: {
      formattedAddress?: string;
      postalAddress?: { regionCode?: string; postalCode?: string; administrativeArea?: string; locality?: string; addressLines?: string[] };
      addressComponents?: { componentName?: { text?: string }; componentType?: string; confirmationLevel?: string; inferred?: boolean; spellCorrected?: boolean; replaced?: boolean }[];
      missingComponentTypes?: string[];
      unconfirmedComponentTypes?: string[];
    };
  };
  responseId?: string;
}
interface AutocompleteResponse {
  suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[];
}
interface PlaceDetails {
  id?: string;
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
}

/** Google's answer → Hullwise's validation shape: missing and suspicious components become issues on Hullwise's fields. */
export function mapGoogleValidation(input: Address, res: ValidateResponse): AddressValidation {
  const a = res.result?.address;
  const issues: AddressValidation["issues"] = [];
  const add = (field: Field, code: AddressValidation["issues"][number]["code"]) => {
    if (!issues.some((i) => i.field === field && i.code === code)) issues.push({ field, code });
  };
  for (const t of a?.missingComponentTypes ?? []) if (REQUIRED_COMPONENTS.has(t) && FIELD_OF[t]) add(FIELD_OF[t]!, "required");
  for (const c of a?.addressComponents ?? []) {
    if (c.confirmationLevel !== "UNCONFIRMED_AND_SUSPICIOUS" || !c.componentType) continue;
    const field = FIELD_OF[c.componentType];
    if (!field) continue;
    add(field, field === "zip" ? "invalid_zip" : field === "country" ? "invalid_country" : "not_found");
  }
  const granularity = res.result?.verdict?.validationGranularity;
  if (granularity && COARSE_GRANULARITY.has(granularity) && !issues.some((i) => i.field === "address1")) add("address1", "not_found");
  const p = a?.postalAddress;
  const lines = p?.addressLines ?? [];
  const normalized: Address | null = p
    ? normalizeAddress({ name: input.name ?? null, address1: lines[0] ?? input.address1 ?? null, address2: lines.slice(1).join(", ") || input.address2 || null, city: p.locality ?? input.city ?? null, province: p.administrativeArea ?? input.province ?? null, zip: p.postalCode ?? input.zip ?? null, country: p.regionCode ?? input.country ?? null, phone: input.phone ?? null })
    : null;
  return { valid: issues.length === 0, issues, normalized };
}

/** Place Details components → Hullwise's address (street and number in the country's order). */
export function mapGooglePlace(place: PlaceDetails, fallbackCountry: string | null): Address {
  const comp = (type: string, short = false) => {
    const c = place.addressComponents?.find((x) => x.types?.includes(type));
    return (short ? c?.shortText : c?.longText) ?? null;
  };
  const country = (comp("country", true) ?? fallbackCountry ?? "").toUpperCase() || null;
  const route = comp("route");
  const number = comp("street_number");
  const street = route ? (number ? (NUMBER_FIRST.has(country ?? "") ? `${number} ${route}` : `${route} ${number}`) : route) : (comp("premise") ?? place.formattedAddress?.split(",")[0] ?? null);
  return normalizeAddress({
    address1: street,
    address2: comp("subpremise"),
    city: comp("locality") ?? comp("postal_town") ?? comp("administrative_area_level_3"),
    province: PROVINCE_LEVEL_2.has(country ?? "") ? comp("administrative_area_level_2", true) : comp("administrative_area_level_1", true),
    zip: comp("postal_code"),
    country,
  });
}

/** Google's error bodies → Hullwise's codes; a rejected key reads as expired credentials. */
function mapError(e: unknown): never {
  if (e instanceof IntegrationError) {
    if (/API_KEY_INVALID|API key not valid|API_KEY_.*_BLOCKED/i.test(e.message)) throw new IntegrationError("token_expired", "Google rejected the API key (invalid, deleted or restricted)");
    if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(e.message)) throw new IntegrationError("permission", "The Address Validation API or Places API (New) is not enabled on the Google Cloud project");
    if (/BILLING_DISABLED|billing/i.test(e.message) && e.code === "permission") throw new IntegrationError("permission", "Billing is not enabled on the Google Cloud project");
    throw e;
  }
  throw new IntegrationError("unknown", e instanceof Error ? e.message : String(e));
}

export class GoogleAddressProvider implements AddressProvider {
  readonly provider = "google-address";
  private readonly http: HttpClient;
  constructor(private readonly creds: GoogleAddressCredentials, opts: HttpOptions = {}) {
    if (!creds.apiKey?.trim()) throw new IntegrationError("invalid_request", "Google API key missing");
    this.http = new HttpClient({ maxRetries: 2, ...opts });
  }

  get calls() {
    return this.http.calls;
  }

  private headers(fieldMask?: string): Record<string, string> {
    return { "content-type": "application/json", "x-goog-api-key": this.creds.apiKey.trim(), ...(fieldMask ? { "x-goog-fieldmask": fieldMask } : {}) };
  }

  /** Validates a known address: proves the key works and the Address Validation API is enabled (one billable request). */
  async testConnection(): Promise<ConnectionTest> {
    try {
      const res = await this.http.request<ValidateResponse>(GOOGLE_ADDRESS_ENDPOINTS.validate, { method: "POST", headers: this.headers(), body: JSON.stringify({ address: { regionCode: "US", addressLines: ["1600 Amphitheatre Parkway", "Mountain View, CA 94043"] } }) });
      if (!res.json?.result) return { ok: false, error: "Unexpected answer from the Address Validation API" };
      return { ok: true, accountName: "Google Address Validation", accountId: "google-address" };
    } catch (e) {
      try {
        mapError(e);
      } catch (m) {
        return { ok: false, error: m instanceof Error ? m.message : String(m) };
      }
    }
  }

  async autocomplete(query: string, opts: { country: string | null; limit?: number }): Promise<AddressSuggestion[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 3, 5));
    const country = opts.country?.trim().toUpperCase() || null;
    try {
      const res = await this.http.request<AutocompleteResponse>(GOOGLE_ADDRESS_ENDPOINTS.autocomplete, { method: "POST", headers: this.headers(), body: JSON.stringify({ input: q.slice(0, 200), ...(country ? { includedRegionCodes: [country.toLowerCase()] } : {}) }) });
      const predictions = (res.json?.suggestions ?? []).map((s) => s.placePrediction).filter((p): p is { placeId: string; text?: { text?: string } } => Boolean(p?.placeId)).slice(0, limit);
      const out: AddressSuggestion[] = [];
      for (const p of predictions) {
        const d = await this.http.request<PlaceDetails>(`${GOOGLE_ADDRESS_ENDPOINTS.details}${encodeURIComponent(p.placeId)}`, { method: "GET", headers: this.headers("id,formattedAddress,addressComponents") });
        out.push({ id: p.placeId, label: p.text?.text ?? d.json?.formattedAddress ?? p.placeId, address: mapGooglePlace(d.json ?? {}, country) });
      }
      return out;
    } catch (e) {
      mapError(e);
    }
  }

  async validate(address: Address): Promise<AddressValidation> {
    const clean = normalizeAddress(address);
    const format = validateAddressFormat(clean);
    // nothing to ask Google about (and nothing to pay for) while the basics are missing
    if (format.some((i) => i.field !== "name" && i.field !== "province" && (i.code === "required" || i.code === "invalid_country"))) return { valid: false, issues: format, normalized: clean };
    try {
      const body = { address: { regionCode: clean.country, ...(clean.zip ? { postalCode: clean.zip } : {}), ...(clean.province ? { administrativeArea: clean.province } : {}), ...(clean.city ? { locality: clean.city } : {}), addressLines: [clean.address1, clean.address2].filter((l): l is string => Boolean(l)) } };
      const res = await this.http.request<ValidateResponse>(GOOGLE_ADDRESS_ENDPOINTS.validate, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
      const mapped = mapGoogleValidation(clean, res.json ?? {});
      // the format rules Google does not check (recipient name, a state where the country needs one) still apply
      const extra = format.filter((f) => !mapped.issues.some((i) => i.field === f.field));
      const issues = [...mapped.issues, ...extra.filter((f) => f.field === "name" || f.field === "province")];
      return { valid: issues.length === 0, issues, normalized: mapped.normalized };
    } catch (e) {
      mapError(e);
    }
  }
}
