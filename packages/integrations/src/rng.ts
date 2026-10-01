/** Deterministic PRNG (mulberry32) shared by the mock adapters and the seed. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of entries) {
        r -= w;
        if (r <= 0) return v;
      }
      return entries[entries.length - 1]![0];
    },
    shuffle: <T>(arr: readonly T[]): T[] => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    uuid: () => {
      const h = () => Math.floor(next() * 0x10000).toString(16).padStart(4, "0");
      return `${h()}${h()}-${h()}-4${h().slice(1)}-${((8 + Math.floor(next() * 4)).toString(16) + h().slice(1))}-${h()}${h()}${h()}`;
    },
  };
}
export type Rng = ReturnType<typeof createRng>;
