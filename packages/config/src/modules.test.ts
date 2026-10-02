import { describe, expect, it } from "vitest";
import { isModuleInPlan } from "./modules";

describe("modules by plan", () => {
  it("includes core.mcp from Growth up, other core modules in every plan, never add-ons", () => {
    expect(isModuleInPlan("core.mcp", "starter")).toBe(false);
    expect(isModuleInPlan("core.mcp", "growth")).toBe(true);
    expect(isModuleInPlan("core.mcp", "scale")).toBe(true);
    expect(isModuleInPlan("core.mcp", "unknown")).toBe(false);
    expect(isModuleInPlan("core.orders", "starter")).toBe(true);
    expect(isModuleInPlan("addon.cod", "scale")).toBe(false);
  });
});
