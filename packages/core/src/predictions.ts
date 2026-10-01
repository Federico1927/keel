/**
 * Per-customer predictions from purchase history alone (no external data):
 *  - MBG/NBD (Batislam, Denizel, Filiztekin 2007): purchase rate and drop-out, fitted per tenant
 *    by maximum likelihood; gives the probability that a customer is still active and the
 *    expected number of orders over a horizon. Unlike BG/NBD, a one-time buyer can drop out,
 *    so P(active) decays for one-time buyers too.
 *  - Gamma-Gamma (Fader, Hardie, Lee 2005): expected value of a customer's future orders,
 *    shrunk towards the store average when the customer has few orders.
 * Expected value over a horizon = expected orders × expected order value.
 * Time unit inside the models is the week; inputs and outputs are days and minor units.
 */

const DAY = 864e5;
const WEEK_DAYS = 7;

/* ---------- numerics ---------- */

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** ln Γ(x) for x > 0, Lanczos approximation (g = 7), relative error below 1e-13. */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0]!;
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Gauss hypergeometric ₂F₁(a, b; c; z) by its power series, for 0 ≤ z < 1. */
export function hyp2f1(a: number, b: number, c: number, z: number, maxTerms = 50_000): number {
  let term = 1;
  let sum = 1;
  for (let n = 0; n < maxTerms; n++) {
    term *= (((a + n) * (b + n)) / ((c + n) * (n + 1))) * z;
    sum += term;
    if (Math.abs(term) <= 1e-13 * Math.abs(sum)) break;
  }
  return sum;
}

/** Derivative-free minimiser (Nelder–Mead with the standard coefficients). Non-finite values count as +∞. */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { maxIter?: number; tol?: number; step?: number } = {}): { x: number[]; fx: number; iterations: number } {
  const maxIter = opts.maxIter ?? 3000;
  const tol = opts.tol ?? 1e-10;
  const step = opts.step ?? 0.5;
  const safe = (x: number[]) => {
    const v = f(x);
    return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
  };
  const n = x0.length;
  let pts: number[][] = [x0.slice(), ...x0.map((_, i) => x0.map((v, j) => (j === i ? v + step : v)))];
  let vals = pts.map(safe);
  let it = 0;
  for (; it < maxIter; it++) {
    const order = vals.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    pts = order.map((i) => pts[i]!);
    vals = order.map((i) => vals[i]!);
    if (Math.abs(vals[n]! - vals[0]!) <= tol * (Math.abs(vals[0]!) + tol)) break;
    const centroid = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p[j]!, 0) / n);
    const along = (k: number, from: number[]) => centroid.map((c, j) => c + k * (from[j]! - c));
    const worst = pts[n]!;
    const xr = along(-1, worst);
    const fr = safe(xr);
    if (fr < vals[0]!) {
      const xe = along(-2, worst);
      const fe = safe(xe);
      pts[n] = fe < fr ? xe : xr;
      vals[n] = Math.min(fe, fr);
    } else if (fr < vals[n - 1]!) {
      pts[n] = xr;
      vals[n] = fr;
    } else {
      const outside = fr < vals[n]!;
      const xc = outside ? along(-0.5, worst) : along(0.5, worst);
      const fc = safe(xc);
      if (fc < Math.min(fr, vals[n]!)) {
        pts[n] = xc;
        vals[n] = fc;
      } else {
        const best = pts[0]!;
        for (let i = 1; i <= n; i++) {
          pts[i] = best.map((b, j) => b + 0.5 * (pts[i]![j]! - b));
          vals[i] = safe(pts[i]!);
        }
      }
    }
  }
  const bestIdx = vals.indexOf(Math.min(...vals));
  return { x: pts[bestIdx]!, fx: vals[bestIdx]!, iterations: it };
}

/* ---------- inputs ---------- */

/** Recency/frequency summary of one customer, in weeks: repeat purchases, age at last purchase, age now. */
export interface RfSummary {
  /** Repeat purchase days (distinct purchase days − 1). */
  x: number;
  /** Weeks between the first and the last purchase day. */
  tx: number;
  /** Weeks between the first purchase day and the observation date. */
  T: number;
}

const dayIndex = (d: Date) => Math.floor(d.getTime() / DAY);

/** Orders on the same calendar day count as one purchase, as the models assume. Orders after `asOf` are ignored. */
export function rfSummary(orderDates: readonly Date[], asOf: Date): RfSummary | null {
  const end = dayIndex(asOf);
  const days = [...new Set(orderDates.map(dayIndex).filter((d) => d <= end))].sort((a, b) => a - b);
  if (!days.length) return null;
  const first = days[0]!;
  const last = days[days.length - 1]!;
  return { x: days.length - 1, tx: (last - first) / WEEK_DAYS, T: Math.max(end - first, 0) / WEEK_DAYS };
}

/* ---------- MBG/NBD ---------- */

export interface MbgParams {
  r: number;
  alpha: number;
  a: number;
  b: number;
}

/** Log-likelihood of one customer under MBG/NBD. */
export function mbgLogLikelihood(p: MbgParams, s: RfSummary): number {
  const { r, alpha, a, b } = p;
  const { x, tx, T } = s;
  const a1 = lnGamma(r + x) - lnGamma(r) + r * Math.log(alpha);
  const a2 = lnGamma(a + b) + lnGamma(b + x + 1) - lnGamma(b) - lnGamma(a + b + x + 1);
  const a3 = -(r + x) * Math.log(alpha + T);
  const a4 = Math.log(a) - Math.log(b + x) + (r + x) * (Math.log(alpha + T) - Math.log(alpha + tx));
  // log(1 + e^a4) without overflow
  const softplus = a4 > 30 ? a4 : Math.log1p(Math.exp(a4));
  return a1 + a2 + a3 + softplus;
}

/** Probability the customer has not dropped out by the observation date. */
export function mbgProbabilityAlive(p: MbgParams, s: RfSummary): number {
  const { r, alpha, a, b } = p;
  const ratio = (r + s.x) * (Math.log(alpha + s.T) - Math.log(alpha + s.tx));
  return 1 / (1 + (a / (b + s.x)) * Math.exp(ratio));
}

/** Expected purchases in the next `t` weeks, conditional on the customer's history. */
export function mbgExpectedPurchases(p: MbgParams, s: RfSummary, t: number): number {
  if (t <= 0) return 0;
  const { r, alpha, a, b } = p;
  const { x, tx, T } = s;
  const z = t / (alpha + T + t);
  const logHyp = Math.log(hyp2f1(r + x, b + x + 1, a + b + x, z));
  const second = 1 - Math.exp(logHyp + (r + x) * (Math.log(alpha + T) - Math.log(alpha + T + t)));
  const numerator = ((a + b + x) / (a - 1)) * second;
  const denominator = 1 + (a / (b + x)) * Math.exp((r + x) * (Math.log(alpha + T) - Math.log(alpha + tx)));
  return Math.max(0, numerator / denominator);
}

interface Weighted<T> {
  value: T;
  weight: number;
}
function groupSummaries(rows: readonly RfSummary[]): Weighted<RfSummary>[] {
  const map = new Map<string, Weighted<RfSummary>>();
  for (const s of rows) {
    const k = `${s.x}|${s.tx}|${s.T}`;
    const g = map.get(k);
    if (g) g.weight++;
    else map.set(k, { value: s, weight: 1 });
  }
  return [...map.values()];
}

/** Sum of `mbgLogLikelihood` over weighted groups, with the Γ terms computed once per repeat count. */
function mbgTotalLogLikelihood(p: MbgParams, groups: readonly Weighted<RfSummary>[]): number {
  const { r, alpha, a, b } = p;
  const constant = lnGamma(a + b) - lnGamma(r) - lnGamma(b) + r * Math.log(alpha);
  const logA = Math.log(a);
  const byX = new Map<number, { g: number; k: number }>();
  let ll = 0;
  for (const { value: s, weight } of groups) {
    let c = byX.get(s.x);
    if (!c) {
      c = { g: lnGamma(r + s.x) + lnGamma(b + s.x + 1) - lnGamma(a + b + s.x + 1), k: logA - Math.log(b + s.x) };
      byX.set(s.x, c);
    }
    const lT = Math.log(alpha + s.T);
    const a4 = c.k + (r + s.x) * (lT - Math.log(alpha + s.tx));
    const softplus = a4 > 30 ? a4 : Math.log1p(Math.exp(a4));
    ll += weight * (constant + c.g - (r + s.x) * lT + softplus);
  }
  return ll;
}

/**
 * Maximum-likelihood fit. Parameters are optimised in log space; `a` is kept above 1 so the
 * expected-purchases formula is defined (a ≤ 1 means an unbounded mean lifetime).
 */
export function fitMbg(rows: readonly RfSummary[]): { params: MbgParams; logLikelihood: number; customers: number } {
  const groups = groupSummaries(rows.filter((s) => s.T > 0));
  const n = groups.reduce((s, g) => s + g.weight, 0);
  const decode = (th: number[]): MbgParams => ({ r: Math.exp(th[0]!), alpha: Math.exp(th[1]!), a: 1 + Math.exp(th[2]!), b: Math.exp(th[3]!) });
  const objective = (th: number[]) => {
    return -mbgTotalLogLikelihood(decode(th), groups) / Math.max(n, 1) + 1e-4 * th.reduce((s, v) => s + v * v, 0);
  };
  const meanT = groups.reduce((s, g) => s + g.weight * g.value.T, 0) / Math.max(n, 1);
  let best = nelderMead(objective, [0, Math.log(Math.max(meanT / 4, 1)), 0, 0]);
  // a restart from the optimum escapes the occasional premature simplex collapse
  best = nelderMead(objective, best.x, { step: 0.2 });
  const params = decode(best.x);
  return { params, logLikelihood: mbgTotalLogLikelihood(params, groups), customers: n };
}

/* ---------- Gamma-Gamma ---------- */

export interface GammaGammaParams {
  p: number;
  q: number;
  /** Scale, in minor units. */
  v: number;
}

/**
 * Fit on customers' order counts and average order values (minor units). Values are scaled by
 * the overall mean for conditioning; `q` is kept above 1 so the population mean exists.
 */
export function fitGammaGamma(rows: readonly { orders: number; avgValueMinor: number }[]): { params: GammaGammaParams; customers: number } | null {
  const usable = rows.filter((r) => r.orders >= 1 && r.avgValueMinor > 0);
  if (usable.length < 20) return null;
  const scale = usable.reduce((s, r) => s + r.avgValueMinor, 0) / usable.length;
  const data = usable.map((r) => ({ x: r.orders, m: r.avgValueMinor / scale }));
  const decode = (th: number[]) => ({ p: Math.exp(th[0]!), q: 1 + Math.exp(th[1]!), v: Math.exp(th[2]!) });
  const objective = (th: number[]) => {
    const { p, q, v } = decode(th);
    const byX = new Map<number, number>();
    const base = q * Math.log(v) - lnGamma(q);
    let ll = 0;
    for (const { x, m } of data) {
      let g = byX.get(x);
      if (g === undefined) {
        g = lnGamma(p * x + q) - lnGamma(p * x) + p * x * Math.log(x);
        byX.set(x, g);
      }
      ll += base + g + (p * x - 1) * Math.log(m) - (p * x + q) * Math.log(x * m + v);
    }
    return -ll / data.length + 1e-4 * th.reduce((s, val) => s + val * val, 0);
  };
  let best = nelderMead(objective, [Math.log(2), Math.log(2), Math.log(2)]);
  best = nelderMead(objective, best.x, { step: 0.2 });
  const d = decode(best.x);
  return { params: { p: d.p, q: d.q, v: d.v * scale }, customers: data.length };
}

/** Expected value of a future order: the customer's own average shrunk towards the store average. */
export function expectedOrderValue(g: GammaGammaParams, orders: number, avgValueMinor: number): number {
  return (g.p * (g.v + orders * avgValueMinor)) / (g.p * orders + g.q - 1);
}

/* ---------- per-customer output ---------- */

export const CHURN_RISKS = ["low", "medium", "high"] as const;
export type ChurnRisk = (typeof CHURN_RISKS)[number];

export interface ChurnThresholds {
  /** P(active) at or above this is low risk. */
  low: number;
  /** P(active) at or above this (and below `low`) is medium risk. */
  medium: number;
}
export const DEFAULT_CHURN_THRESHOLDS: ChurnThresholds = { low: 0.7, medium: 0.4 };

/** Thresholds from tenant settings in percent; `medium` never exceeds `low`. */
export function churnThresholdsFromPct(lowPct: number, mediumPct: number): ChurnThresholds {
  const low = Math.min(Math.max(lowPct, 1), 100) / 100;
  return { low, medium: Math.min(Math.max(mediumPct, 0) / 100, low) };
}

export function churnRiskOf(pAlive: number, th: ChurnThresholds = DEFAULT_CHURN_THRESHOLDS): ChurnRisk {
  return pAlive >= th.low ? "low" : pAlive >= th.medium ? "medium" : "high";
}

export interface CustomerHistory {
  customerId: string;
  orders: { at: Date; valueMinor: number }[];
}

export interface CustomerPrediction {
  customerId: string;
  pAlive: number;
  expectedOrders90: number;
  expectedOrders365: number;
  expectedOrderValueMinor: number;
  /** Expected value of the customer's orders in the next 365 days. */
  predictedValue365Minor: number;
  churnRisk: ChurnRisk;
  /**
   * Expected date of the next order: last order + the customer's own average gap, or the
   * store's median gap to the second order for one-time buyers. Null for high churn risk.
   */
  nextOrderAt: Date | null;
}

export interface PredictionModel {
  mbg: MbgParams;
  gammaGamma: GammaGammaParams | null;
  /** Fallback order value when Gamma-Gamma could not be fitted. */
  meanOrderValueMinor: number;
  /** Median days between first and second order among repeat customers. */
  medianDaysToSecond: number | null;
  customers: number;
  logLikelihood: number;
}

export const MIN_CUSTOMERS_FOR_MODEL = 50;

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Fits both models on the histories as of `asOf`. Null when there are too few customers to fit. */
export function fitPredictionModel(histories: readonly CustomerHistory[], asOf: Date): PredictionModel | null {
  const summaries: RfSummary[] = [];
  const values: { orders: number; avgValueMinor: number }[] = [];
  const gaps: number[] = [];
  let valueSum = 0;
  let valueCount = 0;
  for (const h of histories) {
    const past = h.orders.filter((o) => o.at.getTime() <= asOf.getTime());
    const s = rfSummary(past.map((o) => o.at), asOf);
    if (!s) continue;
    summaries.push(s);
    const total = past.reduce((acc, o) => acc + o.valueMinor, 0);
    values.push({ orders: past.length, avgValueMinor: total / past.length });
    valueSum += total;
    valueCount += past.length;
    const days = [...new Set(past.map((o) => dayIndex(o.at)))].sort((a, b) => a - b);
    if (days.length >= 2) gaps.push(days[1]! - days[0]!);
  }
  if (summaries.length < MIN_CUSTOMERS_FOR_MODEL) return null;
  const mbg = fitMbg(summaries);
  const gg = fitGammaGamma(values);
  return { mbg: mbg.params, gammaGamma: gg?.params ?? null, meanOrderValueMinor: valueCount ? valueSum / valueCount : 0, medianDaysToSecond: medianOf(gaps), customers: mbg.customers, logLikelihood: mbg.logLikelihood };
}

export function predictCustomer(model: PredictionModel, h: CustomerHistory, asOf: Date, th: ChurnThresholds = DEFAULT_CHURN_THRESHOLDS): CustomerPrediction | null {
  const past = h.orders.filter((o) => o.at.getTime() <= asOf.getTime());
  const s = rfSummary(past.map((o) => o.at), asOf);
  if (!s) return null;
  const pAlive = mbgProbabilityAlive(model.mbg, s);
  const e90 = mbgExpectedPurchases(model.mbg, s, 90 / WEEK_DAYS);
  const e365 = mbgExpectedPurchases(model.mbg, s, 365 / WEEK_DAYS);
  const avg = past.reduce((acc, o) => acc + o.valueMinor, 0) / past.length;
  const value = model.gammaGamma ? expectedOrderValue(model.gammaGamma, past.length, avg) : model.meanOrderValueMinor;
  const churnRisk = churnRiskOf(pAlive, th);
  const lastDay = Math.max(...past.map((o) => dayIndex(o.at)));
  const gapDays = s.x > 0 ? (s.tx * WEEK_DAYS) / s.x : model.medianDaysToSecond;
  const nextOrderAt = churnRisk === "high" || gapDays === null ? null : new Date((lastDay + Math.round(gapDays)) * DAY);
  return {
    customerId: h.customerId,
    pAlive,
    expectedOrders90: e90,
    expectedOrders365: e365,
    expectedOrderValueMinor: Math.round(value),
    predictedValue365Minor: Math.round(e365 * value),
    churnRisk,
    nextOrderAt,
  };
}

/* ---------- validation ---------- */

export interface CalibrationRow {
  /** Repeat purchases in the calibration period; the last bucket is "this many or more". */
  repeat: number;
  customers: number;
  predicted: number;
  actual: number;
}
export interface CalibrationReport {
  cutoff: Date;
  end: Date;
  customers: number;
  predicted: number;
  actual: number;
  /** (predicted − actual) / actual; null when nothing was bought in the holdout window. */
  error: number | null;
  rows: CalibrationRow[];
}

/**
 * Back-test: fit on orders up to `cutoff`, predict purchases in (cutoff, end], compare with what
 * happened, overall and by number of repeat purchases. This is the evidence that the model works
 * on this store's data, shown next to the predictions.
 */
export function calibrationReport(histories: readonly CustomerHistory[], cutoff: Date, end: Date, maxBucket = 5): CalibrationReport | null {
  const model = fitPredictionModel(histories, cutoff);
  if (!model) return null;
  const horizon = (dayIndex(end) - dayIndex(cutoff)) / WEEK_DAYS;
  const rows = new Map<number, CalibrationRow>();
  let predicted = 0;
  let actual = 0;
  let customers = 0;
  for (const h of histories) {
    const s = rfSummary(h.orders.map((o) => o.at), cutoff);
    if (!s) continue;
    const exp = mbgExpectedPurchases(model.mbg, s, horizon);
    const realised = new Set(h.orders.filter((o) => o.at.getTime() > cutoff.getTime() && o.at.getTime() <= end.getTime()).map((o) => dayIndex(o.at))).size;
    const bucket = Math.min(s.x, maxBucket);
    const row = rows.get(bucket) ?? { repeat: bucket, customers: 0, predicted: 0, actual: 0 };
    row.customers++;
    row.predicted += exp;
    row.actual += realised;
    rows.set(bucket, row);
    predicted += exp;
    actual += realised;
    customers++;
  }
  return { cutoff, end, customers, predicted, actual, error: actual > 0 ? (predicted - actual) / actual : null, rows: [...rows.values()].sort((a, b) => a.repeat - b.repeat) };
}

/* ---------- full run ---------- */

export interface PredictionRun {
  model: PredictionModel | null;
  predictions: CustomerPrediction[];
  calibration: CalibrationReport | null;
}

/**
 * One complete run, shared by the service and the seed: fit on everything up to `asOf`,
 * predict every customer, and back-test on the last `calibrationDays` days.
 */
export function runPredictionModel(histories: readonly CustomerHistory[], asOf: Date, opts: { thresholds?: ChurnThresholds; calibrationDays?: number } = {}): PredictionRun {
  const model = fitPredictionModel(histories, asOf);
  if (!model) return { model: null, predictions: [], calibration: null };
  const predictions: CustomerPrediction[] = [];
  for (const h of histories) {
    const p = predictCustomer(model, h, asOf, opts.thresholds);
    if (p) predictions.push(p);
  }
  const cutoff = new Date(asOf.getTime() - (opts.calibrationDays ?? 180) * DAY);
  return { model, predictions, calibration: calibrationReport(histories, cutoff, asOf) };
}
