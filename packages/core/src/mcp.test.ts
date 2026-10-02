import { describe, expect, it } from "vitest";
import { canMcpSetOrderStatus, maskEmailAddress, maskPersonName, maskPhoneNumber, maskPii, mcpPiiMode, narrowMcpScopes, parseMcpScopes, sanitizeFreeText, sanitizeSearch } from "./mcp";

describe("MCP PII masking", () => {
  it("masks emails, phones and names in the documented formats", () => {
    expect(maskEmailAddress("mario.rossi@example.com")).toBe("m***@example.com");
    expect(maskEmailAddress("nope")).toBe("•••");
    expect(maskPhoneNumber("+39 333 123 4567")).toBe("•••4567");
    expect(maskPhoneNumber("123")).toBe("•••");
    expect(maskPersonName("Mario Rossi")).toBe("Mario R.");
    expect(maskPersonName("Maria de la Cruz")).toBe("Maria D. L. C.");
    expect(maskPersonName("Cher")).toBe("C.");
  });

  it("walks nested objects and arrays, masks street addresses and keeps dates, cities and amounts", () => {
    const placedAt = new Date("2026-09-01T10:00:00Z");
    const input = {
      orders: [{ name: "NW-1001", customerName: "Giulia Ferri", email: "giulia@ferri.it", phone: "+39 340 000 1122", total: 129.9, placedAt, tags: ["vip"] }],
      shippingAddress: { name: "Giulia Ferri", address1: "Via Roma 1", address2: null, city: "Milano", zip: "20100", country: "IT", phone: "3400001122" },
      note: "Call her at +39 340 000 1122 or write to giulia@ferri.it",
      product: { name: "Linen shirt", sku: "LS-001" },
    };
    const out = maskPii(input);
    expect(out.orders[0]).toEqual({ name: "NW-1001", customerName: "Giulia F.", email: "g***@ferri.it", phone: "•••1122", total: 129.9, placedAt, tags: ["vip"] });
    expect(out.shippingAddress).toEqual({ name: "Giulia F.", address1: "•••", address2: null, city: "Milano", zip: "•••", country: "IT", phone: "•••1122" });
    expect(out.note).toBe("Call her at •••1122 or write to g***@ferri.it");
    expect(out.product).toEqual({ name: "Linen shirt", sku: "LS-001" });
    expect(input.orders[0]!.email).toBe("giulia@ferri.it");
  });

  it("masks extra name keys a tool declares, and emails in any string", () => {
    expect(maskPii({ customers: [{ name: "Luca Romano", orders: 3 }] }, { nameKeys: ["name"] })).toEqual({ customers: [{ name: "Luca R.", orders: 3 }] });
    expect(maskPii({ label: "luca@x.io bought twice" })).toEqual({ label: "l***@x.io bought twice" });
    expect(maskPii("2026-10-01")).toBe("2026-10-01");
  });

  it("gives full PII only to allowed roles when the tenant enabled it", () => {
    expect(mcpPiiMode("customer_care", true)).toBe("full");
    expect(mcpPiiMode("customer_care", false)).toBe("masked");
    expect(mcpPiiMode("marketing", true)).toBe("masked");
    expect(mcpPiiMode("viewer", true)).toBe("masked");
  });
});

describe("MCP input", () => {
  it("sanitises search terms: no wildcards or control characters, capped at 80", () => {
    expect(sanitizeSearch("  50%_off\u0000\n shirt ")).toBe("50 off shirt");
    expect(sanitizeSearch("x".repeat(200))).toHaveLength(80);
    expect(sanitizeSearch(42)).toBe("");
  });
  it("keeps newlines in free text but drops control and bidi characters", () => {
    expect(sanitizeFreeText("Line 1\r\n\n\n\nLine 2\u202E\u0007")).toBe("Line 1\n\nLine 2");
    expect(sanitizeFreeText("y".repeat(5000), 10)).toBe("yyyyyyyyyy");
  });
});

describe("MCP scopes and writes", () => {
  it("parses scopes, drops unknown ones and always includes read", () => {
    expect(parseMcpScopes("write:notes admin bogus")).toEqual(["read", "write:notes"]);
    expect(parseMcpScopes(undefined)).toEqual(["read"]);
    expect(narrowMcpScopes(["read", "write:notes"], ["write:notes", "write:orders"])).toEqual(["read", "write:notes"]);
  });
  it("allows only reversible review and hold status changes", () => {
    expect(canMcpSetOrderStatus("new", "confirmed")).toBe(true);
    expect(canMcpSetOrderStatus("on_hold", "confirmed")).toBe(true);
    expect(canMcpSetOrderStatus("confirmed", "cancelled")).toBe(false);
    expect(canMcpSetOrderStatus("shipped", "delivered")).toBe(false);
    expect(canMcpSetOrderStatus("delivered", "on_hold")).toBe(false);
  });
});
