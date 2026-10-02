import { describe, expect, it } from "vitest";
import { TENANT_ROLES, canDo } from "./roles";

describe("edit_order permission", () => {
  it("lets owner, admin, operations and customer care edit orders; not marketing or viewer", () => {
    const allowed = TENANT_ROLES.filter((r) => canDo(r, "edit_order"));
    expect(allowed).toEqual(["owner", "admin", "operations", "customer_care"]);
  });
});

describe("manage_dashboard permission", () => {
  it("is owner and admin only: everyone else reads the tenant's dashboards", () => {
    expect(TENANT_ROLES.filter((r) => canDo(r, "manage_dashboard"))).toEqual(["owner", "admin"]);
  });
});
