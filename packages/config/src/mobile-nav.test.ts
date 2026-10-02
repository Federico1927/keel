import { describe, expect, it } from "vitest";
import { DEFAULT_MOBILE_NAV, MOBILE_NAV_DESTINATIONS, MOBILE_NAV_SLOTS, resolveMobileNav, type MobileNavKey } from "./mobile-nav";
import { TENANT_ROLES, canViewPage } from "./roles";

const all = () => true;

describe("mobile bottom navigation", () => {
  it("uses the role's defaults, at most four, each one the role may open", () => {
    for (const role of TENANT_ROLES) {
      const nav = resolveMobileNav(role, (k) => canViewPage(role, MOBILE_NAV_DESTINATIONS[k].page));
      expect(nav.length).toBeLessThanOrEqual(MOBILE_NAV_SLOTS);
      expect(nav.length).toBeGreaterThan(0);
      for (const k of nav) expect(canViewPage(role, MOBILE_NAV_DESTINATIONS[k].page)).toBe(true);
      expect(nav[0]).toBe(DEFAULT_MOBILE_NAV[role][0]);
    }
    expect(resolveMobileNav("operations", all)).toEqual(["dashboard", "orders", "fulfilment", "returns"]);
  });

  it("follows the tenant's choice, ignores unknown keys and fills what the user cannot open", () => {
    expect(resolveMobileNav("operations", all, ["cod_queue", "orders", "bogus"])).toEqual(["cod_queue", "orders", "dashboard", "fulfilment"]);
    const noCod = (k: MobileNavKey) => k !== "cod_queue";
    expect(resolveMobileNav("operations", noCod, ["cod_queue", "orders"])).toEqual(["orders", "dashboard", "fulfilment", "returns"]);
    expect(resolveMobileNav("marketing", all, [])).toEqual(DEFAULT_MOBILE_NAV.marketing);
    expect(resolveMobileNav("viewer", all, ["orders", "orders", "orders", "orders", "orders"])).toEqual(["orders", "dashboard", "fulfilment", "returns"]);
  });
});
