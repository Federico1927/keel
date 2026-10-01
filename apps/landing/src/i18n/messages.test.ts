import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import itMessages from "../../messages/it.json";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

/** Same rule as the product: a key present in one language and missing in another fails the build. */
describe("landing translation files", () => {
  const base = flatten(en).sort();
  it("it.json has exactly the keys of en.json", () => {
    const keys = flatten(itMessages).sort();
    expect({
      missing: base.filter((k) => !keys.includes(k)),
      extra: keys.filter((k) => !base.includes(k)),
    }).toEqual({ missing: [], extra: [] });
  });
  it("has no empty strings", () => {
    for (const m of [en, itMessages]) {
      const empty = flatten(m).filter(
        (k) =>
          k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], m) === "",
      );
      expect(empty).toEqual([]);
    }
  });
});
