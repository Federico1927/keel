import { describe, expect, it } from "vitest";
import { API_VERSION_SUPPORT, staleApiVersions } from "./versions";

describe("pinned vendor API versions", () => {
  it("pins the current versions", () => {
    expect(API_VERSION_SUPPORT.shopify.version).toBe("2026-10");
    expect(API_VERSION_SUPPORT.meta.version).toBe("v26.0");
    expect(API_VERSION_SUPPORT.google.version).toBe("v23");
  });

  it("no pinned version is past its support end (bump the version and the date when this fails)", () => {
    expect(staleApiVersions(new Date())).toEqual([]);
  });

  it("reports a version once its date has passed", () => {
    expect(staleApiVersions(new Date("2027-10-17T00:00:00Z")).map((v) => v.platform)).toEqual(expect.arrayContaining(["shopify", "google", "meta"]));
    expect(staleApiVersions(new Date("2027-01-15T00:00:00Z"), 30).map((v) => v.platform)).toEqual(["google"]);
  });
});
