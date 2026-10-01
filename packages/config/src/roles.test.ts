import { describe, expect, it } from "vitest";
import { TENANT_ROLES, canDo } from "./roles";

describe("edit_order permission", () => {
  it("lets owner, admin, operations and customer care edit orders; not marketing or viewer", () => {
    const allowed = TENANT_ROLES.filter((r) => canDo(r, "edit_order"));
    expect(allowed).toEqual(["owner", "admin", "operations", "customer_care"]);
  });
});
