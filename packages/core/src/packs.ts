/**
 * Case packs and option mix (purchasing). A pack is a carton defined by the tenant on ONE option
 * of any name ("Size", "Material", "Scent"…): units per option value, e.g. S×1 M×2 L×2 XL×1.
 * Nothing here knows what an option means; names are matched case-insensitively.
 */

export interface CasePackDef {
  name: string;
  optionName: string;
  /** Units per option value; values with 0 units are not in the carton. */
  units: Record<string, number>;
}

export interface OptionedVariant {
  id: string;
  optionValues: Record<string, string>;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Units in one carton. */
export function packUnits(pack: Pick<CasePackDef, "units">): number {
  return Object.values(pack.units).reduce((s, n) => s + Math.max(0, Math.floor(n || 0)), 0);
}

/** The value a variant has for an option name (case-insensitive), or null. */
export function optionValueOf(optionValues: Record<string, string>, optionName: string): string | null {
  const key = Object.keys(optionValues).find((k) => norm(k) === norm(optionName));
  return key === undefined ? null : (optionValues[key] ?? null);
}

/** Units the pack carries for a value (case-insensitive match on the value). */
export function packUnitsFor(pack: Pick<CasePackDef, "units">, value: string): number {
  const key = Object.keys(pack.units).find((k) => norm(k) === norm(value));
  return key === undefined ? 0 : Math.max(0, Math.floor(pack.units[key] ?? 0));
}

/** A pack fits a product when the product has the pack's option and at least one of its values. */
export function packFitsProduct(pack: Pick<CasePackDef, "optionName" | "units">, options: readonly { name: string; values: readonly string[] }[]): boolean {
  const opt = options.find((o) => norm(o.name) === norm(pack.optionName));
  return Boolean(opt && opt.values.some((v) => packUnitsFor(pack, v) > 0));
}

export interface PackGroup<V extends OptionedVariant> {
  /** Stable key made of the other options' values ("" when the product has only the pack's option). */
  key: string;
  /** The other options' values, e.g. { Color: "Navy" }. */
  values: Record<string, string>;
  members: { variant: V; value: string }[];
}

/**
 * Splits a product's variants into option groups for a pack: variants that share every option
 * except the pack's one form a group (one carton line per colour, for a size pack). Variants
 * without the pack's option are left out.
 */
export function packGroups<V extends OptionedVariant>(variants: readonly V[], optionName: string): PackGroup<V>[] {
  const groups = new Map<string, PackGroup<V>>();
  for (const v of variants) {
    const value = optionValueOf(v.optionValues, optionName);
    if (value === null) continue;
    const rest = Object.fromEntries(Object.entries(v.optionValues).filter(([k]) => norm(k) !== norm(optionName)).sort(([a], [b]) => a.localeCompare(b)));
    const key = Object.entries(rest).map(([k, x]) => `${k}=${x}`).join("|");
    const g = groups.get(key) ?? { key, values: rest, members: [] };
    g.members.push({ variant: v, value });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface PackDemandResult {
  packs: number;
  /** Units the cartons bring per option value. */
  unitsByValue: Record<string, number>;
  /** Units brought minus units needed per value (negative = still short; values outside the pack are always short). */
  surplusByValue: Record<string, number>;
}

/**
 * Number of cartons for one option group from a demand split per option value.
 * `total` (default) buys enough cartons for the group's total need, so the mix follows the pack;
 * `cover` buys enough for every single value not to be short (more stock, no gaps).
 */
export function packsForDemand(pack: CasePackDef, needByValue: Record<string, number>, mode: "total" | "cover" = "total"): PackDemandResult {
  const per = packUnits(pack);
  const need = Object.fromEntries(Object.entries(needByValue).map(([k, n]) => [k, Math.max(0, Math.ceil(n || 0))]));
  let packs = 0;
  if (per > 0) {
    if (mode === "cover") {
      for (const [value, n] of Object.entries(need)) {
        const u = packUnitsFor(pack, value);
        if (u > 0 && n > 0) packs = Math.max(packs, Math.ceil(n / u));
      }
    } else {
      const covered = Object.entries(need).filter(([value]) => packUnitsFor(pack, value) > 0).reduce((s, [, n]) => s + n, 0);
      packs = covered > 0 ? Math.ceil(covered / per) : 0;
    }
  }
  const unitsByValue: Record<string, number> = {};
  for (const [value, u] of Object.entries(pack.units)) if (u > 0) unitsByValue[value] = Math.floor(u) * packs;
  const surplusByValue: Record<string, number> = {};
  for (const [value, n] of Object.entries(need)) surplusByValue[value] = packUnitsFor(pack, value) * packs - n;
  for (const [value, u] of Object.entries(unitsByValue)) if (!Object.keys(need).some((k) => norm(k) === norm(value))) surplusByValue[value] = u;
  return { packs, unitsByValue, surplusByValue };
}

/** Units per variant when `packs` cartons are bought for a group. */
export function packAllocation<V extends OptionedVariant>(pack: CasePackDef, group: PackGroup<V>, packs: number): Record<string, number> {
  const n = Math.max(0, Math.floor(packs));
  return Object.fromEntries(group.members.map((m) => [m.variant.id, packUnitsFor(pack, m.value) * n]));
}

export interface MixRow {
  key: string;
  values: Record<string, string>;
  units: number;
  /** 0..1; equal shares when nothing sold. */
  share: number;
}

/**
 * Sales share per option combination. With `optionNames` the rows are aggregated on those options
 * only (e.g. the share of each size across colours); without, one row per full combination.
 */
export function optionMixShares(rows: readonly { optionValues: Record<string, string>; units: number }[], optionNames?: readonly string[]): MixRow[] {
  const agg = new Map<string, MixRow>();
  for (const r of rows) {
    const entries = Object.entries(r.optionValues)
      .filter(([k]) => !optionNames || optionNames.some((n) => norm(n) === norm(k)))
      .sort(([a], [b]) => a.localeCompare(b));
    const key = entries.map(([k, v]) => `${k}=${v}`).join("|");
    const cur = agg.get(key) ?? { key, values: Object.fromEntries(entries), units: 0, share: 0 };
    cur.units += Math.max(0, r.units || 0);
    agg.set(key, cur);
  }
  const out = [...agg.values()];
  const total = out.reduce((s, r) => s + r.units, 0);
  for (const r of out) r.share = total > 0 ? r.units / total : out.length ? 1 / out.length : 0;
  return out.sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
}

/**
 * Splits `total` units by share with the largest-remainder method. With `multiple` > 1 the split
 * is done in blocks of that size, so every key gets a multiple and the sum is `total` rounded up
 * to the multiple. Ties go to the larger share, then to the key order given.
 */
export function allocateByShare(total: number, shares: readonly { key: string; share: number }[], opts: { multiple?: number | null } = {}): Record<string, number> {
  const m = Math.max(1, Math.floor(opts.multiple ?? 1));
  const blocks = Math.max(0, Math.ceil(Math.max(0, total) / m));
  const sum = shares.reduce((s, x) => s + Math.max(0, x.share), 0);
  const weights = shares.map((x) => (sum > 0 ? Math.max(0, x.share) / sum : shares.length ? 1 / shares.length : 0));
  const exact = weights.map((w) => w * blocks);
  const base = exact.map((e) => Math.floor(e));
  let left = blocks - base.reduce((s, b) => s + b, 0);
  const order = exact.map((e, i) => ({ i, rem: e - Math.floor(e), w: weights[i]! })).sort((a, b) => b.rem - a.rem || b.w - a.w || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i]! += 1;
    left--;
  }
  return Object.fromEntries(shares.map((x, i) => [x.key, base[i]! * m]));
}

export interface PoLineDraft {
  variantId: string;
  quantity: number;
  unitCostMinor: number;
}

/** An allocation (units per variant) as purchase order lines; zero lines dropped, missing cost → 0. */
export function allocationToPoLines(allocation: Record<string, number>, costByVariant: Record<string, number | null | undefined>): PoLineDraft[] {
  return Object.entries(allocation)
    .filter(([, q]) => q > 0)
    .map(([variantId, q]) => ({ variantId, quantity: Math.floor(q), unitCostMinor: Math.max(0, Math.round(costByVariant[variantId] ?? 0)) }));
}
