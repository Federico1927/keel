import { describe, expect, it } from "vitest";
import { calibrationReport, churnRiskOf, expectedOrderValue, fitGammaGamma, fitMbg, fitPredictionModel, hyp2f1, lnGamma, mbgExpectedPurchases, mbgProbabilityAlive, nelderMead, predictCustomer, rfSummary, type CustomerHistory, type MbgParams } from "./predictions";

const DAY = 864e5;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(u: () => number) {
  return Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}
/** Marsaglia–Tsang, shape k, scale 1. */
function gamma(u: () => number, k: number): number {
  if (k < 1) return gamma(u, k + 1) * Math.pow(u(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(u);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    if (Math.log(u()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** Simulates the MBG/NBD story: Poisson purchases at rate λ, drop-out with probability p after each purchase (the first included). */
function simulate(p: MbgParams, customers: number, end: Date, seed = 7): CustomerHistory[] {
  const u = rng(seed);
  const out: CustomerHistory[] = [];
  for (let i = 0; i < customers; i++) {
    const lambda = gamma(u, p.r) / p.alpha; // per week
    const ga = gamma(u, p.a);
    const drop = ga / (ga + gamma(u, p.b));
    const firstWeek = u() * 104; // acquired over two years
    const start = end.getTime() - firstWeek * 7 * DAY;
    const value = 4000 + Math.round(u() * 6000);
    const orders = [{ at: new Date(start), valueMinor: value }];
    let t = start;
    for (;;) {
      if (u() < drop) break;
      t += (-Math.log(1 - u()) / lambda) * 7 * DAY;
      if (t > end.getTime()) break;
      orders.push({ at: new Date(t), valueMinor: value + Math.round((u() - 0.5) * 1000) });
    }
    out.push({ customerId: `c${i}`, orders });
  }
  return out;
}

describe("numerics", () => {
  it("lnGamma matches known values", () => {
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
    expect(lnGamma(101)).toBeCloseTo(363.73937555556347, 8);
  });
  it("hyp2f1 matches a closed form", () => {
    for (const z of [0.1, 0.5, 0.9]) expect(hyp2f1(1, 1, 2, z)).toBeCloseTo(-Math.log(1 - z) / z, 9);
  });
  it("nelderMead finds the minimum of the Rosenbrock function", () => {
    const r = nelderMead(([x, y]) => (1 - x!) ** 2 + 100 * (y! - x! * x!) ** 2, [-1.2, 1], { maxIter: 5000 });
    expect(r.x[0]).toBeCloseTo(1, 3);
    expect(r.x[1]).toBeCloseTo(1, 3);
  });
});

describe("rfSummary", () => {
  it("counts purchase days, not orders, and ignores the future", () => {
    const asOf = new Date("2026-03-01T00:00:00Z");
    const s = rfSummary([new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T15:00:00Z"), new Date("2026-01-15T09:00:00Z"), new Date("2026-04-01T09:00:00Z")], asOf);
    expect(s).toEqual({ x: 1, tx: 2, T: 59 / 7 });
    expect(rfSummary([], asOf)).toBeNull();
  });
});

describe("MBG/NBD", () => {
  const p: MbgParams = { r: 0.8, alpha: 8, a: 2, b: 6 };
  it("P(active) decays with time since the last purchase, for one-time buyers too", () => {
    const recent = mbgProbabilityAlive(p, { x: 0, tx: 0, T: 2 });
    const old = mbgProbabilityAlive(p, { x: 0, tx: 0, T: 80 });
    expect(recent).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0);
    expect(mbgProbabilityAlive(p, { x: 5, tx: 50, T: 51 })).toBeGreaterThan(mbgProbabilityAlive(p, { x: 5, tx: 10, T: 51 }));
  });
  it("expected purchases grow with frequency and with the horizon, and are zero for no horizon", () => {
    const s = { x: 3, tx: 30, T: 32 };
    expect(mbgExpectedPurchases(p, s, 0)).toBe(0);
    expect(mbgExpectedPurchases(p, s, 52)).toBeGreaterThan(mbgExpectedPurchases(p, s, 13));
    expect(mbgExpectedPurchases(p, s, 52)).toBeGreaterThan(mbgExpectedPurchases(p, { x: 1, tx: 30, T: 32 }, 52));
  });
  it("recovers the parameters of simulated data and predicts a held-out year", () => {
    const end = new Date("2026-06-30T00:00:00Z");
    const data = simulate(p, 4000, end);
    const cutoff = new Date(end.getTime() - 26 * 7 * DAY);
    const fit = fitMbg(data.map((h) => rfSummary(h.orders.map((o) => o.at), end)!));
    expect(fit.params.r).toBeGreaterThan(0.5);
    expect(fit.params.r).toBeLessThan(1.2);
    expect(fit.params.alpha).toBeGreaterThan(4);
    expect(fit.params.alpha).toBeLessThan(14);
    const report = calibrationReport(data, cutoff, end)!;
    expect(report.customers).toBeGreaterThan(2500);
    expect(Math.abs(report.error!)).toBeLessThan(0.15);
    expect(report.rows[0]!.repeat).toBe(0);
  });
});

describe("Gamma-Gamma", () => {
  it("shrinks a customer's average towards the store average, less so with more orders", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ orders: 1 + (i % 6), avgValueMinor: 3000 + ((i * 7919) % 7000) }));
    const fit = fitGammaGamma(rows)!;
    expect(fit).not.toBeNull();
    const storeMean = (fit.params.p * fit.params.v) / (fit.params.q - 1);
    expect(storeMean).toBeGreaterThan(4000);
    expect(storeMean).toBeLessThan(8000);
    const one = expectedOrderValue(fit.params, 1, 20000);
    const ten = expectedOrderValue(fit.params, 10, 20000);
    expect(one).toBeLessThan(ten);
    expect(ten).toBeLessThan(20000);
    expect(one).toBeGreaterThan(storeMean);
  });
  it("needs enough customers", () => {
    expect(fitGammaGamma([{ orders: 1, avgValueMinor: 100 }])).toBeNull();
  });
});

describe("predictCustomer", () => {
  const end = new Date("2026-06-30T00:00:00Z");
  const data = simulate({ r: 0.8, alpha: 8, a: 2, b: 6 }, 1500, end, 11);
  const model = fitPredictionModel(data, end)!;
  it("returns probabilities, expected orders, value and a churn class", () => {
    const loyal: CustomerHistory = { customerId: "x", orders: [0, 30, 60, 90, 120].map((d) => ({ at: new Date(end.getTime() - (130 - d) * DAY), valueMinor: 8000 })) };
    const lapsed: CustomerHistory = { customerId: "y", orders: [{ at: new Date(end.getTime() - 600 * DAY), valueMinor: 8000 }] };
    const a = predictCustomer(model, loyal, end)!;
    const b = predictCustomer(model, lapsed, end)!;
    expect(a.pAlive).toBeGreaterThan(b.pAlive);
    expect(a.expectedOrders365).toBeGreaterThan(a.expectedOrders90);
    expect(a.predictedValue365Minor).toBeGreaterThan(b.predictedValue365Minor);
    expect(a.nextOrderAt!.getTime()).toBeGreaterThan(end.getTime() - 20 * DAY);
    expect(b.churnRisk).toBe("high");
    expect(b.nextOrderAt).toBeNull();
  });
  it("needs a minimum number of customers to fit", () => {
    expect(fitPredictionModel(data.slice(0, 10), end)).toBeNull();
  });
  it("classifies churn risk by thresholds", () => {
    expect(churnRiskOf(0.9)).toBe("low");
    expect(churnRiskOf(0.5)).toBe("medium");
    expect(churnRiskOf(0.1)).toBe("high");
    expect(churnRiskOf(0.5, { low: 0.4, medium: 0.2 })).toBe("low");
  });
});

describe("likelihood", () => {
  it("the fitted log-likelihood equals the per-customer sum", async () => {
    const { mbgLogLikelihood } = await import("./predictions");
    const rows = [{ x: 0, tx: 0, T: 10 }, { x: 2, tx: 5, T: 20 }, { x: 2, tx: 5, T: 20 }, { x: 7, tx: 40, T: 41 }];
    const fit = fitMbg(rows);
    const direct = rows.reduce((s, r) => s + mbgLogLikelihood(fit.params, r), 0);
    expect(fit.logLikelihood).toBeCloseTo(direct, 8);
  });
});

describe("runPredictionModel", () => {
  it("fits, predicts every customer with orders and back-tests", async () => {
    const { runPredictionModel } = await import("./predictions");
    const end = new Date("2026-06-30T00:00:00Z");
    const data = simulate({ r: 0.8, alpha: 8, a: 2, b: 6 }, 800, end, 3);
    const run = runPredictionModel([...data, { customerId: "none", orders: [] }], end);
    expect(run.model).not.toBeNull();
    expect(run.predictions).toHaveLength(800);
    expect(run.calibration!.customers).toBeGreaterThan(0);
    expect(runPredictionModel(data.slice(0, 5), end)).toEqual({ model: null, predictions: [], calibration: null });
  });
});
