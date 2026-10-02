import { describe, expect, it } from "vitest";
import { formatNumber, formatPrice } from "./format";

/** Grouping must not depend on the ICU version (Node vs browser) or hydration breaks in Italian. */
describe("format", () => {
  it("groups four-digit numbers in every locale", () => {
    expect(formatNumber("it", 1000)).toBe("1.000");
    expect(formatNumber("en", 1000)).toBe("1,000");
    expect(formatPrice("it", 1190)).toBe("1.190 $");
    expect(formatPrice("en", 1190)).toBe("$1,190");
    expect(formatNumber("es", 1000)).toBe("1.000");
    expect(formatPrice("es", 1190)).toBe("1.190\u00a0$");
  });
});
