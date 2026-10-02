import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import itMessages from "../../messages/it.json";
import es from "../../messages/es.json";
import { LANDING_LOCALES } from "@/config/site";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

const OTHERS = { it: itMessages, es } as Record<string, Record<string, unknown>>;

/** Same rule as the product: a key present in one language and missing in another fails the build. */
describe("landing translation files", () => {
  const base = flatten(en).sort();
  it("covers every published locale", () => {
    expect([...LANDING_LOCALES].sort()).toEqual(["en", ...Object.keys(OTHERS)].sort());
  });
  it.each(Object.keys(OTHERS))("%s.json has exactly the keys of en.json", (locale) => {
    const keys = flatten(OTHERS[locale]!).sort();
    expect({
      missing: base.filter((k) => !keys.includes(k)),
      extra: keys.filter((k) => !base.includes(k)),
    }).toEqual({ missing: [], extra: [] });
  });
  it("has no empty strings", () => {
    for (const m of [en, ...Object.values(OTHERS)]) {
      const empty = flatten(m).filter(
        (k) =>
          k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], m) === "",
      );
      expect(empty).toEqual([]);
    }
  });
});
