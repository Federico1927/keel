import { describe, expect, it } from "vitest";
import { TENANT_ROLES } from "./roles";
import { bulkActionsFor, canBulk, canExportList } from "./lists";

describe("list permissions", () => {
  it("bulk actions follow the matrix", () => {
    expect(bulkActionsFor("owner", "orders")).toEqual(["status", "cancel", "assign", "tag"]);
    expect(bulkActionsFor("viewer", "orders")).toEqual([]);
    expect(bulkActionsFor("marketing", "products")).toEqual([]);
    expect(bulkActionsFor("operations", "products")).toEqual(["status", "price", "compare_at", "tags"]);
    expect(canBulk("customer_care", "returns", "refund")).toBe(true);
    expect(canBulk("marketing", "returns", "refund")).toBe(false);
    expect(canBulk("owner", "orders", "delete")).toBe(false);
  });
  it("exports need the page and either write or the export action", () => {
    expect(TENANT_ROLES.filter((r) => canExportList(r, "orders"))).toEqual(["owner", "admin", "operations", "customer_care", "marketing"]);
    expect(TENANT_ROLES.filter((r) => canExportList(r, "purchasing"))).toEqual(["owner", "admin", "operations"]);
    expect(canExportList("viewer", "customers")).toBe(false);
  });
});
