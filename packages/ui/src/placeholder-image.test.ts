import { describe, expect, it } from "vitest";
import { parsePlaceholderPath, placeholderProductSvg, swatchColor } from "./placeholder-image";

describe("demo placeholder images", () => {
  it("parses only well-formed paths", () => {
    expect(parsePlaceholderPath(["linen-shirt", "2-navy.svg"])).toEqual({ handle: "linen-shirt", position: 2, label: "navy" });
    expect(parsePlaceholderPath(["linen-shirt", "2-navy.png"])).toBeNull();
    expect(parsePlaceholderPath(["../etc", "1-a.svg"])).toBeNull();
    expect(parsePlaceholderPath(["a"])).toBeNull();
  });
  it("draws a deterministic SVG with the option colour and escaped text", () => {
    const a = placeholderProductSvg({ handle: "linen-shirt-ii", label: "matte-black", position: 1 });
    expect(a).toBe(placeholderProductSvg({ handle: "linen-shirt-ii", label: "matte-black", position: 1 }));
    expect(a).toContain(swatchColor("matte black"));
    expect(a).toContain("Linen Shirt II");
    expect(a).toContain("Matte Black");
    expect(a.startsWith("<svg")).toBe(true);
    expect(placeholderProductSvg({ handle: "x", label: "detail", position: 3 })).toContain("Detail");
    expect(swatchColor("unknown colour")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
