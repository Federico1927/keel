import type { PageKey } from "@hullwise/config";

/**
 * Data completeness (issue #99): the gaps that make the numbers wrong or the features weaker, each
 * with how much it affects and where it gets fixed. The service counts, this module decides what is
 * a gap, how serious it is, the score and who may act on it. Nothing here depends on the payment
 * method: every check holds for any shop.
 */

export const DATA_HEALTH_SEVERITIES = ["critical", "warning", "info"] as const;
export type DataHealthSeverity = (typeof DATA_HEALTH_SEVERITIES)[number];

export const DATA_HEALTH_CHECKS = [
  "commerce_connection",
  "product_costs",
  "tax_rates",
  "shipping_costs",
  "fixed_costs",
  "campaign_links",
  "integration_errors",
  "payment_fees",
  "state_rules",
  "cost_actuals",
  "return_costs",
  "suppliers",
] as const;
export type DataHealthCheckId = (typeof DATA_HEALTH_CHECKS)[number];

/** What the service measured for one check. `count` is the number of gaps (variants, countries, campaigns…), `sample` what was looked at. */
export interface DataHealthInput {
  id: DataHealthCheckId;
  count: number;
  sample: number;
  /** False when the check does not apply to this tenant (e.g. no supplier yet: purchasing is not used). */
  applicable?: boolean;
  affectedOrders?: number | null;
  /** Revenue (or ad spend for campaign links) the gap touches, minor units. */
  affectedRevenueMinor?: number | null;
  /** Denominator of the share: the window's revenue (or spend) and orders. */
  totalRevenueMinor?: number | null;
  totalOrders?: number | null;
  /** Values for the message (methods, countries, month…). */
  params?: Record<string, string | number | string[]>;
  /** Extra query for the fix link (period, filter values). */
  query?: Record<string, string>;
}

export interface DataHealthCheckDefinition {
  id: DataHealthCheckId;
  /** Page whose write access fixes the gap: a role without it never sees the row. */
  page: PageKey;
  /** Fix destination, relative to the tenant base (`/t/<slug>/`). */
  path: string;
  query: Record<string, string>;
  /** Severity from what was measured (share = affected / total, 0–1, null without a denominator). */
  severity: (input: DataHealthInput, share: number | null) => DataHealthSeverity;
}

const fixed = (s: DataHealthSeverity) => () => s;
const def = (id: DataHealthCheckId, page: PageKey, path: string, query: Record<string, string>, severity: DataHealthCheckDefinition["severity"]): DataHealthCheckDefinition => ({ id, page, path, query, severity });

export const DATA_HEALTH_DEFINITIONS: Record<DataHealthCheckId, DataHealthCheckDefinition> = {
  // without the store connection there are no orders, products or stock to work on
  commerce_connection: def("commerce_connection", "integrations", "integrations", {}, fixed("critical")),
  // lines sold without a cost count as pure margin: every margin, P/L and campaign profit is optimistic
  product_costs: def("product_costs", "products", "products/quality", { issue: "missing_cost" }, (_i, share) => (share !== null && share >= 0.05 ? "critical" : "warning")),
  // net revenue uses the tenant country's rate (or none) for a country without a rate; the home country missing skews every order
  tax_rates: def("tax_rates", "settings", "settings", { tab: "taxes" }, (i) => (i.params?.homeCountryMissing ? "critical" : "warning")),
  // shipping falls back to Hullwise's generic per-order figure, never the shop's
  shipping_costs: def("shipping_costs", "settings", "settings", { tab: "operational" }, (_i, share) => (share !== null && share >= 0.5 ? "critical" : "warning")),
  fixed_costs: def("fixed_costs", "settings", "analytics/costs", {}, fixed("warning")),
  // spend not tied to products: product profit, stock-aware advice and reorder hints miss it
  campaign_links: def("campaign_links", "campaigns", "campaigns", { links: "none" }, (_i, share) => (share !== null && share >= 0.2 ? "warning" : "info")),
  integration_errors: def("integration_errors", "integrations", "integrations", {}, fixed("warning")),
  payment_fees: def("payment_fees", "settings", "settings", { tab: "operational" }, fixed("info")),
  state_rules: def("state_rules", "settings", "settings/order-states", {}, (_i, share) => (share !== null && share >= 0.1 ? "warning" : "info")),
  cost_actuals: def("cost_actuals", "settings", "analytics/costs", {}, fixed("info")),
  return_costs: def("return_costs", "settings", "returns/portal", {}, fixed("info")),
  suppliers: def("suppliers", "purchasing", "purchasing/suppliers", {}, fixed("info")),
};

/** Every page a data-health row can send to (the widget's visibility rule reads the same list in @hullwise/config). */
export const DATA_HEALTH_PAGES: readonly PageKey[] = [...new Set(Object.values(DATA_HEALTH_DEFINITIONS).map((d) => d.page))];

export interface DataHealthItem {
  id: DataHealthCheckId;
  severity: DataHealthSeverity;
  count: number;
  sample: number;
  affectedOrders: number | null;
  affectedRevenueMinor: number | null;
  share: number | null;
  params: Record<string, string | number | string[]>;
  fix: { page: PageKey; path: string; query: Record<string, string> };
}

export type DataHealthStatus = "all_set" | "good" | "attention" | "critical";

export interface DataHealthSummary {
  score: number;
  status: DataHealthStatus;
  critical: number;
  warning: number;
  info: number;
}

export interface DataHealthReport {
  /** Gaps, most serious first (then in catalog order). */
  items: DataHealthItem[];
  /** Checks that ran and found nothing. */
  passed: DataHealthCheckId[];
  /** Checks that do not apply to this tenant. */
  skipped: DataHealthCheckId[];
  summary: DataHealthSummary;
}

const SEVERITY_RANK: Record<DataHealthSeverity, number> = { critical: 0, warning: 1, info: 2 };
/** Points a gap takes off the score of 100. */
export const DATA_HEALTH_PENALTY: Record<DataHealthSeverity, number> = { critical: 30, warning: 10, info: 3 };

function shareOf(i: DataHealthInput): number | null {
  const ratio = (a: number | null | undefined, b: number | null | undefined) => (a !== null && a !== undefined && b ? Math.min(1, Math.max(0, a / b)) : null);
  return ratio(i.affectedRevenueMinor, i.totalRevenueMinor) ?? ratio(i.affectedOrders, i.totalOrders) ?? ratio(i.count, i.sample);
}

export function summarizeDataHealth(items: readonly Pick<DataHealthItem, "severity">[]): DataHealthSummary {
  const n = (s: DataHealthSeverity) => items.filter((i) => i.severity === s).length;
  const critical = n("critical");
  const warning = n("warning");
  const info = n("info");
  const score = Math.max(0, 100 - items.reduce((s, i) => s + DATA_HEALTH_PENALTY[i.severity], 0));
  const status: DataHealthStatus = critical ? "critical" : warning ? "attention" : info ? "good" : "all_set";
  return { score, status, critical, warning, info };
}

/** Turns measurements into the report: a check with a count above zero is a gap; unknown ids are ignored. */
export function evaluateDataHealth(inputs: readonly DataHealthInput[]): DataHealthReport {
  const items: DataHealthItem[] = [];
  const passed: DataHealthCheckId[] = [];
  const skipped: DataHealthCheckId[] = [];
  for (const i of inputs) {
    const d = DATA_HEALTH_DEFINITIONS[i.id];
    if (!d) continue;
    if (i.applicable === false) {
      skipped.push(i.id);
      continue;
    }
    if (i.count <= 0) {
      passed.push(i.id);
      continue;
    }
    const share = shareOf(i);
    items.push({
      id: i.id,
      severity: d.severity(i, share),
      count: i.count,
      sample: i.sample,
      affectedOrders: i.affectedOrders ?? null,
      affectedRevenueMinor: i.affectedRevenueMinor ?? null,
      share,
      params: i.params ?? {},
      fix: { page: d.page, path: d.path, query: { ...d.query, ...(i.query ?? {}) } },
    });
  }
  // within a severity, the catalog order: it lists the checks from the one everything depends on (the store connection) down
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || DATA_HEALTH_CHECKS.indexOf(a.id) - DATA_HEALTH_CHECKS.indexOf(b.id));
  return { items, passed, skipped, summary: summarizeDataHealth(items) };
}

/** The report as one role sees it: only the gaps it can fix (write access to the fix page), with the summary recomputed. */
export function dataHealthForRole(report: DataHealthReport, canAct: (page: PageKey) => boolean): DataHealthReport {
  const visible = (id: DataHealthCheckId) => canAct(DATA_HEALTH_DEFINITIONS[id].page);
  const items = report.items.filter((i) => canAct(i.fix.page));
  return { items, passed: report.passed.filter(visible), skipped: report.skipped.filter(visible), summary: summarizeDataHealth(items) };
}

/** Fix link of a gap, relative to the tenant base. */
export function dataHealthHref(item: Pick<DataHealthItem, "fix">): string {
  const q = new URLSearchParams(Object.entries(item.fix.query)).toString();
  return q ? `${item.fix.path}?${q}` : item.fix.path;
}

/** Months are `YYYY-MM`: the last month that has fully ended before `now` (UTC calendar). */
export function lastClosedMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A per-order cost setting valid on `day` (`YYYY-MM-DD`, validity bounds inclusive). */
export function costSettingCovers(rows: readonly { validFrom: string; validTo: string | null }[], day: string): boolean {
  return rows.some((r) => r.validFrom <= day && (!r.validTo || r.validTo >= day));
}

/**
 * Orders whose P/L shipping cost is Hullwise's generic default: placed on a day no per-order cost
 * setting covers, in a month without a carrier invoice (actual), while the shop never set its own
 * default. Input: sale orders per local day.
 */
export function ordersOnDefaultShipping(ordersByDay: readonly { day: string; orders: number }[], perOrderSettings: readonly { validFrom: string; validTo: string | null }[], monthsWithActual: ReadonlySet<string>, tenantSetDefault: boolean): number {
  if (tenantSetDefault) return 0;
  return ordersByDay.filter((d) => !monthsWithActual.has(d.day.slice(0, 7)) && !costSettingCovers(perOrderSettings, d.day)).reduce((s, d) => s + d.orders, 0);
}
