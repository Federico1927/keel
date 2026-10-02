import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { IntegrationError } from "../types";
import { GOOGLE_ADDRESS_ENDPOINTS, GoogleAddressProvider, mapGooglePlace } from "./index";
import { AUTOCOMPLETE, ERRORS, PLACE_DETAILS, VALIDATE_LOCALITY_ONLY, VALIDATE_OK, VALIDATE_SUSPICIOUS } from "./__fixtures__/google";

const noSleep = { sleep: async () => undefined };
const validateWith = (body: unknown, status = 200, headers?: Record<string, string>) => fixtureFetch([{ match: (u) => u === GOOGLE_ADDRESS_ENDPOINTS.validate, status, headers, body }]);
const provider = (fetchImpl: ReturnType<typeof fixtureFetch>) => new GoogleAddressProvider({ apiKey: "AIza-test-key" }, { fetchImpl, ...noSleep });

describe("GoogleAddressProvider.validate", () => {
  it("accepts a confirmed address and returns Google's normalized form, with the key in a header", async () => {
    const calls: { url: string; headers?: Record<string, string>; body?: string }[] = [];
    const base = validateWith(VALIDATE_OK);
    const p = provider(async (url, init) => {
      calls.push({ url, headers: init?.headers, body: init?.body });
      return base(url, init);
    });
    const r = await p.validate({ name: "Ada Lovelace", address1: "1600 amphitheatre pkwy", city: "Mountain View", province: "CA", zip: "94043", country: "us", phone: "+16502530000" });
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.normalized).toMatchObject({ name: "Ada Lovelace", address1: "1600 Amphitheatre Pkwy", city: "Mountain View", province: "CA", zip: "94043-1351", country: "US", phone: "+16502530000" });
    expect(calls[0]!.url).not.toContain("AIza");
    expect(calls[0]!.headers!["x-goog-api-key"]).toBe("AIza-test-key");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ address: { regionCode: "US", postalCode: "94043", administrativeArea: "CA", locality: "Mountain View", addressLines: ["1600 amphitheatre pkwy"] } });
  });

  it("maps a suspicious postal code and a missing house number to Keel's issues", async () => {
    const r = await provider(validateWith(VALIDATE_SUSPICIOUS)).validate({ name: "Mario Rossi", address1: "Via Torino", city: "Roma", zip: "20121", country: "IT" });
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining([{ field: "zip", code: "invalid_zip" }, { field: "address1", code: "required" }]));
    expect(r.normalized).toMatchObject({ zip: "00184", city: "Roma", province: "RM" });
  });

  it("reports a street Google could only place at town level as not found", async () => {
    const r = await provider(validateWith(VALIDATE_LOCALITY_ONLY)).validate({ name: "Anna", address1: "Via Inesistente 99", city: "Bologna", zip: "40121", country: "IT" });
    expect(r.issues).toEqual([{ field: "address1", code: "not_found" }]);
  });

  it("keeps the format rules Google does not check and skips the call when the basics are missing", async () => {
    const p = provider(validateWith(VALIDATE_OK));
    const noName = await p.validate({ address1: "1600 Amphitheatre Pkwy", city: "Mountain View", province: "CA", zip: "94043", country: "US" });
    expect(noName.issues).toEqual([{ field: "name", code: "required" }]);
    const before = p.calls.length;
    const empty = await p.validate({ name: "X", country: "IT" });
    expect(empty.valid).toBe(false);
    expect(empty.issues).toEqual(expect.arrayContaining([{ field: "address1", code: "required" }, { field: "city", code: "required" }]));
    expect(p.calls.length).toBe(before);
  });

  it("maps Google errors: rejected key, API not enabled, quota, bad request", async () => {
    const addr = { name: "A", address1: "Via Roma 1", city: "Milano", zip: "20121", country: "IT" };
    const err = async (e: { status: number; body: unknown; headers?: Record<string, string> }) => (await provider(validateWith(e.body, e.status, e.headers)).validate(addr).catch((x: unknown) => x)) as IntegrationError;
    expect(await err(ERRORS.keyInvalid)).toMatchObject({ code: "token_expired" });
    expect(await err(ERRORS.serviceDisabled)).toMatchObject({ code: "permission", message: expect.stringContaining("not enabled") });
    const rl = await err(ERRORS.rateLimited);
    expect(rl).toBeInstanceOf(IntegrationError);
    expect(rl.code).toBe("rate_limited");
    expect(await err(ERRORS.badRequest)).toMatchObject({ code: "invalid_request" });
    expect(() => new GoogleAddressProvider({ apiKey: " " })).toThrow(IntegrationError);
  });
});

describe("GoogleAddressProvider.autocomplete", () => {
  it("suggests structured addresses from Places Autocomplete and Place Details, restricted to the country", async () => {
    const bodies: string[] = [];
    const routes = fixtureFetch([
      { match: (u) => u === GOOGLE_ADDRESS_ENDPOINTS.autocomplete, body: (_u: string, init?: { body?: string }) => (bodies.push(init?.body ?? ""), AUTOCOMPLETE) },
      { match: (u) => u.startsWith(GOOGLE_ADDRESS_ENDPOINTS.details), body: (u: string) => PLACE_DETAILS[decodeURIComponent(u.slice(GOOGLE_ADDRESS_ENDPOINTS.details.length))] },
    ]);
    const p = provider(routes);
    const s = await p.autocomplete("via roma 1", { country: "IT", limit: 3 });
    expect(JSON.parse(bodies[0]!)).toEqual({ input: "via roma 1", includedRegionCodes: ["it"] });
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ id: "ChIJ-roma-1", label: "Via Roma, 1, Milano, MI, Italia", address: expect.objectContaining({ address1: "Via Roma 1", address2: null, city: "Milano", province: "MI", zip: "20121", country: "IT" }) });
    expect(s[1]!.address).toMatchObject({ city: "Torino", province: "TO", zip: "10121" });
    expect(await p.autocomplete("vi", { country: "IT" })).toEqual([]);
  });

  it("writes the house number first where the country does", () => {
    expect(mapGooglePlace(PLACE_DETAILS["ChIJ-us-1"] as never, null)).toMatchObject({ address1: "350 5th Avenue", address2: "Suite 300", city: "New York", province: "NY", zip: "10118", country: "US" });
  });
});

describe("GoogleAddressProvider.testConnection", () => {
  it("proves the key with one validation and explains failures", async () => {
    expect(await provider(validateWith(VALIDATE_OK)).testConnection()).toMatchObject({ ok: true, accountName: "Google Address Validation" });
    expect(await provider(validateWith(ERRORS.keyInvalid.body, 400)).testConnection()).toMatchObject({ ok: false, error: expect.stringContaining("API key") });
    expect(await provider(validateWith(ERRORS.serviceDisabled.body, 403)).testConnection()).toMatchObject({ ok: false, error: expect.stringContaining("not enabled") });
  });
});
