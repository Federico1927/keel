import { describe, expect, it } from "vitest";
import {
  ADDON_MODULES,
  CORE_MODULES,
  MODULES,
  PLAN_KEYS,
  isAddonModule,
  isModuleInPlan,
  type ModuleKey,
  type PlanKey,
} from "@hullwise/config";
import en from "../../messages/en.json";
import {
  ADDON_CLAIMS,
  COMING_SOON,
  COMPARISON_CLAIMS,
  EXTRA_FEATURES,
  FAQ_CLAIMS,
  HOW_CLAIMS,
  MODULE_SLIDES,
  PLAN_FEATURE_CLAIMS,
  type Claim,
} from "./claims";
import { ADDONS, PLANS } from "./pricing";

const modulesOf = (c: Claim): readonly ModuleKey[] => (c.kind === "module" ? c.modules : []);
/** Enterprise is a Scale contract with custom terms: it includes what Scale includes. */
const planKey = (id: string): PlanKey => (id === "enterprise" ? "scale" : (id as PlanKey));
const get = (path: string): unknown =>
  path.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], en);

describe("every claim on the landing maps to a built module of @hullwise/config", () => {
  const textClaims: Claim[] = [
    ...Object.values(FAQ_CLAIMS),
    ...Object.values(HOW_CLAIMS),
    ...Object.values(COMPARISON_CLAIMS),
  ];
  const all: Claim[] = [
    ...MODULE_SLIDES.map((s) => s.claim),
    ...EXTRA_FEATURES.map((f) => f.claim),
    ...Object.values(PLAN_FEATURE_CLAIMS),
    ...Object.values(ADDON_CLAIMS),
    ...textClaims,
  ];
  it("module keys exist", () => {
    for (const c of all) for (const m of modulesOf(c)) expect(MODULES[m], m).toBeDefined();
  });
  it("core claims and priced add-ons point at implemented modules", () => {
    for (const c of [
      ...MODULE_SLIDES.map((s) => s.claim),
      ...EXTRA_FEATURES.map((f) => f.claim),
      ...Object.values(PLAN_FEATURE_CLAIMS),
      ...textClaims,
    ])
      for (const m of modulesOf(c)) expect(MODULES[m].availability, m).toBe("implemented");
  });
  it("every implemented core module is claimed somewhere on the page", () => {
    const claimed = new Set(all.flatMap(modulesOf));
    for (const m of CORE_MODULES)
      if (MODULES[m].availability === "implemented") expect(claimed.has(m), m).toBe(true);
  });
  it("every claim has its copy", () => {
    for (const s of MODULE_SLIDES)
      expect(get(`modules.items.${s.key}.title`), s.key).toBeTypeOf("string");
    for (const f of EXTRA_FEATURES)
      expect(get(`modules.extra.items.${f.key}.title`), f.key).toBeTypeOf("string");
    for (const id of Object.keys(PLAN_FEATURE_CLAIMS))
      expect(get(`pricing.features.${id}`), id).toBeTypeOf("string");
    for (const id of Object.keys(ADDON_CLAIMS))
      expect(get(`addons.items.${id}.title`), id).toBeTypeOf("string");
    for (const c of COMING_SOON)
      expect(get(`coming_soon.items.${c.key}.title`), c.key).toBeTypeOf("string");
    for (const k of Object.keys(FAQ_CLAIMS))
      expect(get(`faq.items.${k}.q`), k).toBeTypeOf("string");
    for (const k of Object.keys(HOW_CLAIMS))
      expect(get(`how.steps.${k}.title`), k).toBeTypeOf("string");
    for (const k of Object.keys(COMPARISON_CLAIMS))
      expect(get(`comparison.hullwise_items.${k}`), k).toBeTypeOf("string");
  });
  it("every FAQ answer and comparison line on the page is registered", () => {
    expect(Object.keys(FAQ_CLAIMS).sort()).toEqual(Object.keys(en.faq.items).sort());
    expect(Object.keys(COMPARISON_CLAIMS).sort()).toEqual(
      Object.keys(en.comparison.hullwise_items).sort(),
    );
    expect(Object.keys(HOW_CLAIMS).sort()).toEqual(Object.keys(en.how.steps).sort());
  });
  it("a plan badge on a feature matches the module's minimum plan", () => {
    for (const f of EXTRA_FEATURES) {
      const min = modulesOf(f.claim)
        .map((m) => MODULES[m].minPlan)
        .find(Boolean);
      expect("fromPlan" in f ? f.fromPlan : undefined, f.key).toBe(min);
    }
  });
});

describe("plan cards follow the product's plan gating", () => {
  it("every feature line has a claim", () => {
    for (const p of PLANS)
      for (const f of p.features) expect(PLAN_FEATURE_CLAIMS[f], `${p.id}.${f}`).toBeDefined();
  });
  it("a plan lists a module only if the plan includes it", () => {
    for (const p of PLANS)
      for (const f of p.features)
        for (const m of modulesOf(PLAN_FEATURE_CLAIMS[f]!))
          expect(isModuleInPlan(m, planKey(p.id)), `${p.id}: ${m}`).toBe(true);
  });
  it("each core module is listed from the first plan that includes it (inherited by the next ones)", () => {
    const listed = new Map<ModuleKey, string>();
    for (const p of PLANS)
      for (const f of p.features)
        for (const m of modulesOf(PLAN_FEATURE_CLAIMS[f]!)) if (!listed.has(m)) listed.set(m, p.id);
    for (const m of CORE_MODULES) {
      if (m === "core.platform") continue; // users, roles and audit: the "unlimited users" and audit lines of every card
      const first = PLAN_KEYS.find((k) => isModuleInPlan(m, k));
      expect(listed.get(m), m).toBe(first);
    }
  });
  it("plans inherit in order", () => {
    for (const [i, p] of PLANS.entries()) if (i > 0) expect(p.inheritsFrom).toBe(PLANS[i - 1]!.id);
  });
});

describe("add-ons", () => {
  it("every add-on card has a claim and maps only to add-on modules", () => {
    for (const a of ADDONS) {
      const c = ADDON_CLAIMS[a.id];
      expect(c, a.id).toBeDefined();
      for (const m of modulesOf(c!)) expect(isAddonModule(m), m).toBe(true);
    }
  });
  it("priced add-ons are built and cost what the product bills; on-quote ones are catalog slots or services", () => {
    for (const a of ADDONS) {
      const mods = modulesOf(ADDON_CLAIMS[a.id]!);
      if (a.kind === "monthly") {
        expect(mods, a.id).toHaveLength(1);
        expect(MODULES[mods[0]!].availability).toBe("implemented");
        expect(MODULES[mods[0]!].monthlyPriceMinor).toBe(a.price * 100);
      } else for (const m of mods) expect(MODULES[m].monthlyPriceMinor, m).toBeNull();
    }
  });
  it("every built add-on of the product is on the page", () => {
    const listed = new Set(ADDONS.flatMap((a) => modulesOf(ADDON_CLAIMS[a.id]!)));
    for (const m of ADDON_MODULES)
      if (MODULES[m].availability === "implemented") expect(listed.has(m), m).toBe(true);
  });
  it("cash on delivery is never the first add-on (payment-method neutrality)", () => {
    expect(ADDONS[0]?.id).not.toBe("cod");
  });
});

describe("coming soon", () => {
  it("features being built are not claimed anywhere else", () => {
    const elsewhere = new Set<string>([
      ...MODULE_SLIDES.map((s) => s.key),
      ...EXTRA_FEATURES.map((f) => f.key),
      ...Object.keys(PLAN_FEATURE_CLAIMS),
      ...Object.keys(ADDON_CLAIMS),
    ]);
    for (const c of COMING_SOON) expect(elsewhere.has(c.key), c.key).toBe(false);
  });
});
