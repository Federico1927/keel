import { describe, expect, it } from "vitest";
import { ngramStats, phrasesOf, rankNgrams, registerStopWords, stopWordsFor, tokenize, type NgramItem } from "./ngrams";

const item = (text: string, spend: number, margin: number, extra: Partial<NgramItem> = {}): NgramItem => ({ text, spendMinor: spend, impressions: spend * 10, clicks: spend / 10, conversions: 0, orders: margin > 0 ? 1 : 0, netRevenueMinor: Math.max(0, margin * 2), marginMinor: margin, ...extra });

describe("tokenize and phrases", () => {
  it("lower-cases, folds accents and splits on punctuation", () => {
    expect(tokenize("Camicia di LINO — più fresca! 50%")).toEqual(["camicia", "di", "lino", "piu", "fresca", "50"]);
  });

  it("builds 1–3 word phrases that never start or end with a stop word, per language", () => {
    const it = phrasesOf("Camicia in lino naturale", stopWordsFor(["it"]));
    expect(it).toEqual(expect.arrayContaining(["camicia", "lino", "naturale", "lino naturale", "camicia in lino"]));
    expect(it).not.toContain("in");
    expect(it).not.toContain("camicia in");
    expect(it).not.toContain("in lino naturale");
    const es = phrasesOf("Zapatos de cuero para el verano", stopWordsFor(["es"]));
    expect(es).toContain("zapatos de cuero");
    expect(es).not.toContain("para");
    const en = phrasesOf("The best oak table for your home", stopWordsFor(["en"]));
    expect(en).toEqual(expect.arrayContaining(["oak table", "best oak table", "home"]));
    expect(en).not.toContain("the best");
  });

  it("counts a phrase once per text and accepts extra stop words", () => {
    expect(phrasesOf("sale sale sale", stopWordsFor(["en"])).filter((p) => p === "sale")).toHaveLength(1);
    registerStopWords("xx", ["northwind"]);
    expect(phrasesOf("Northwind linen", stopWordsFor(["xx"]))).toEqual(["linen"]);
  });
});

describe("ngramStats", () => {
  it("a two-word phrase common to profitable ads ranks first by profit", () => {
    const ads = [
      item("Natural linen shirt for summer", 1000, 6000),
      item("Natural linen dress, light all day", 1200, 5000),
      item("Wrap skirt in natural linen", 800, 4000),
      item("Linen trousers on sale", 5000, 500),
      item("Natural look for the weekend", 4000, 0),
      item("Shirt and trousers bundle", 3000, 800),
    ];
    const rows = ngramStats(ads, { langs: ["en"], minItems: 2 });
    expect(rows[0]).toMatchObject({ phrase: "natural linen", n: 2, items: 3, spendMinor: 3000, marginMinor: 15000, profitMinor: 12000 });
    const linen = rows.find((r) => r.phrase === "linen")!;
    expect(linen.items).toBe(4);
    expect(linen.profitMinor).toBeLessThan(rows[0]!.profitMinor);
    // rare phrases (a single ad) are noise and dropped
    expect(rows.find((r) => r.phrase === "wrap skirt")).toBeUndefined();
    const { winners, losers } = rankNgrams(rows, "profit", 3);
    expect(winners[0]!.phrase).toBe("natural linen");
    expect(losers[0]!.profitMinor).toBeLessThan(0);
  });

  it("sums are spend- and click-weighted and the volume threshold filters small phrases", () => {
    const rows = ngramStats([item("oak table", 1000, 3000, { conversions: 2, clicks: 100 }), item("oak chair", 3000, 1000, { conversions: 1, clicks: 50 })], { langs: ["en"], minItems: 2, minSpendMinor: 0 });
    const oak = rows.find((r) => r.phrase === "oak")!;
    expect(oak.spendMinor).toBe(4000);
    expect(oak.roas).toBeCloseTo((6000 + 2000) / 4000);
    expect(oak.conversionRate).toBeCloseTo(3 / 150);
    expect(ngramStats([item("oak table", 10, 30), item("oak chair", 10, 30)], { langs: ["en"], minSpendMinor: 1000, minImpressions: 1000 })).toEqual([]);
  });

  it("ranks by ROAS ignoring phrases without spend", () => {
    const rows = ngramStats([item("blue vase", 0, 100), item("blue vase large", 0, 100), item("red lamp", 1000, 5000), item("red lamp tall", 1000, 2000)], { langs: ["en"] });
    const { winners } = rankNgrams(rows, "roas");
    expect(winners.every((r) => r.spendMinor > 0)).toBe(true);
    expect(winners[0]!.phrase).toMatch(/red|lamp/);
  });
});
