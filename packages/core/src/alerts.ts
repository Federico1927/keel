/**
 * Alert rules evaluated on daily series. Two kinds: a threshold ("ROAS below 1.5 for 2 days")
 * and an anomaly ("spend more than 3 robust deviations away from the last 28 days"). Pure: the
 * service builds the series, this decides whether to fire and explains why.
 */
export const ALERT_METRICS = ["revenue", "orders", "ad_spend", "roas", "mer", "conversion_rate", "aov", "cancel_rate", "stockouts"] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export type AlertCondition =
  | { kind: "threshold"; op: "lt" | "gt"; value: number; days: number }
  | { kind: "anomaly"; direction: "up" | "down" | "both"; sensitivity: number; baselineDays: number };

export interface AlertEvaluation {
  fired: boolean;
  /** Latest value of the series. */
  value: number | null;
  /** Baseline used (threshold value, or the median of the baseline window). */
  baseline: number | null;
  /** Robust z-score for anomalies. */
  score: number | null;
  reason: "threshold" | "anomaly_up" | "anomaly_down" | "insufficient_data" | "ok";
}

export function medianOf(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation scaled to a standard deviation (×1.4826). */
export function robustSpread(values: readonly number[]): number {
  if (!values.length) return 0;
  const med = medianOf(values);
  return 1.4826 * medianOf(values.map((v) => Math.abs(v - med)));
}

/** `series` is oldest → newest, one value per day; null = no data that day. */
export function evaluateAlert(condition: AlertCondition, series: readonly (number | null)[]): AlertEvaluation {
  const values = series.filter((v): v is number => v !== null && Number.isFinite(v));
  const latest = series.length ? series[series.length - 1]! : null;
  if (condition.kind === "threshold") {
    const recent = series.slice(-condition.days);
    if (recent.length < condition.days || recent.some((v) => v === null)) return { fired: false, value: latest, baseline: condition.value, score: null, reason: "insufficient_data" };
    const hit = recent.every((v) => (condition.op === "lt" ? v! < condition.value : v! > condition.value));
    return { fired: hit, value: latest, baseline: condition.value, score: null, reason: hit ? "threshold" : "ok" };
  }
  const baseline = values.slice(0, -1).slice(-condition.baselineDays);
  if (latest === null || baseline.length < Math.min(7, condition.baselineDays)) return { fired: false, value: latest, baseline: null, score: null, reason: "insufficient_data" };
  const med = medianOf(baseline);
  const spread = robustSpread(baseline) || Math.abs(med) * 0.05 || 1;
  const score = (latest - med) / spread;
  const up = score >= condition.sensitivity && condition.direction !== "down";
  const down = score <= -condition.sensitivity && condition.direction !== "up";
  return { fired: up || down, value: latest, baseline: med, score: Math.round(score * 100) / 100, reason: up ? "anomaly_up" : down ? "anomaly_down" : "ok" };
}

/* ---------- creative fatigue ---------- */

export interface CreativeDay {
  date: string;
  impressions: number;
  clicks: number;
  spendMinor: number;
  reach?: number;
}

export interface FatigueResult {
  /** CTR of the first and the last 7 days with data. */
  ctrStart: number | null;
  ctrEnd: number | null;
  ctrChange: number | null;
  /** Frequency (impressions / reach) of the last 7 days, when reach is known. */
  frequency: number | null;
  fatigued: boolean;
  level: "fresh" | "watch" | "fatigued" | "no_data";
}

const ctrOf = (days: readonly CreativeDay[]) => {
  const imp = days.reduce((s, d) => s + d.impressions, 0);
  return imp > 0 ? days.reduce((s, d) => s + d.clicks, 0) / imp : null;
};

/** Fatigue = CTR down ≥ 25 % from the first to the last week, or frequency above 3 with CTR falling. */
export function creativeFatigue(days: readonly CreativeDay[]): FatigueResult {
  const active = days.filter((d) => d.impressions > 0);
  if (active.length < 10) return { ctrStart: null, ctrEnd: null, ctrChange: null, frequency: null, fatigued: false, level: "no_data" };
  const start = ctrOf(active.slice(0, 7));
  const end = ctrOf(active.slice(-7));
  const last = active.slice(-7);
  const reach = last.reduce((s, d) => s + (d.reach ?? 0), 0);
  const frequency = reach > 0 ? last.reduce((s, d) => s + d.impressions, 0) / reach : null;
  const change = start && end !== null ? (end - start) / start : null;
  const fatigued = (change !== null && change <= -0.25) || (frequency !== null && frequency > 3 && change !== null && change < 0);
  const watch = !fatigued && change !== null && change <= -0.1;
  return { ctrStart: start, ctrEnd: end, ctrChange: change, frequency, fatigued, level: fatigued ? "fatigued" : watch ? "watch" : "fresh" };
}

/** Parses the naming convention "FORMAT | HOOK | ANGLE | ..." (separator |, - or _) into tags; missing parts are null. */
export function parseCreativeName(name: string, order: readonly ("format" | "hook" | "angle")[] = ["format", "hook", "angle"]): Record<"format" | "hook" | "angle", string | null> {
  const parts = name.split(/\s*[|]\s*|\s+-\s+|__/).map((p) => p.trim()).filter(Boolean);
  const out: Record<"format" | "hook" | "angle", string | null> = { format: null, hook: null, angle: null };
  order.forEach((k, i) => (out[k] = parts[i] ? parts[i]!.toLowerCase() : null));
  return out;
}
