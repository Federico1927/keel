/** Money is always handled as integer minor units (cents). */
export type Minor = number;

export function toMinor(amount: number | string, decimals = 2): Minor {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** decimals);
}

export function fromMinor(minor: Minor, decimals = 2): number {
  return minor / 10 ** decimals;
}

export function pct(minor: Minor, bps: number): Minor {
  return Math.round((minor * bps) / 10_000);
}

export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}
