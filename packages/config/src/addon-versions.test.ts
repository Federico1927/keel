import { describe, expect, it } from "vitest";
import { ADDON_MODULES, MODULES } from "./modules";
import { ADDON_VERSIONS, activatableAddons, canActivateAddon, displayedVersions, releasedVersion, wipVersion } from "./addon-versions";

describe("add-on versions (#77)", () => {
  it("activates COD (v1 released) and refuses customer campaigns (v1 still in development)", () => {
    expect(releasedVersion("addon.cod")?.version).toBe(1);
    expect(wipVersion("addon.cod")?.version).toBe(2);
    expect(canActivateAddon("addon.cod")).toBe(true);
    expect(releasedVersion("addon.customer_campaigns")).toBeNull();
    expect(wipVersion("addon.customer_campaigns")?.version).toBe(1);
    expect(canActivateAddon("addon.customer_campaigns")).toBe(false);
    expect(activatableAddons()).toEqual(["addon.cod"]);
  });

  it("never activates catalog-only add-ons, and every implemented add-on has at least one version", () => {
    for (const key of ADDON_MODULES) {
      if (MODULES[key].availability === "on_request") {
        expect(canActivateAddon(key)).toBe(false);
        expect(displayedVersions(key)).toEqual([]);
      } else expect(ADDON_VERSIONS[key].length, key).toBeGreaterThan(0);
    }
  });

  it("shows at most two versions: the highest released and the work in progress above it", () => {
    for (const key of ADDON_MODULES) {
      const shown = displayedVersions(key);
      expect(shown.length).toBeLessThanOrEqual(2);
      if (shown.length === 2) {
        expect(shown[0]!.status).toBe("released");
        expect(shown[1]!.status).toBe("in_development");
        expect(shown[1]!.version).toBeGreaterThan(shown[0]!.version);
      }
      const versions = ADDON_VERSIONS[key].map((v) => v.version);
      expect(new Set(versions).size, `${key} has duplicate versions`).toBe(versions.length);
    }
  });
});
