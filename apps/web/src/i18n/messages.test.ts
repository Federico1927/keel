import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import itMessages from "../../messages/it.json";
import es from "../../messages/es.json";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

/** Fails when a key exists in one language and not in the others (CLAUDE.md §5). */
describe("translation files", () => {
  const base = flatten(en).sort();
  for (const [name, messages] of [
    ["it", itMessages],
    ["es", es],
  ] as const) {
    it(`${name}.json has exactly the keys of en.json`, () => {
      const keys = flatten(messages).sort();
      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });
  }
  it("has no empty strings", () => {
    for (const m of [en, itMessages, es]) {
      const empty = flatten(m).filter((k) => k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], m) === "");
      expect(empty).toEqual([]);
    }
  });
});
