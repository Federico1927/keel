import { z } from "zod";
import { isAddonModule, type ModuleKey } from "./modules";
import { canDo, canViewPage, type PageKey, type TenantRole } from "./roles";

/**
 * Tenant dashboards (issue #43): a typed widget catalog and a metric catalog. Every widget type is
 * backed by a tested service loader (packages/services/src/dashboards, packages/addon-cod for COD);
 * custom metrics are formulas over the base metrics below, never queries.
 */

/* ---------- metric catalog ---------- */

export type MetricFormat = "money" | "ratio" | "percent" | "number" | "days";
export type MetricGroup = "finance" | "orders" | "customers" | "inventory" | "ads";
/** Where a metric's number clicks through (apps/web builds the URL with the period). */
export type MetricLink = "pnl" | "orders" | "orders_cancelled" | "returns" | "customers" | "inventory" | "purchasing" | "campaigns" | "campaigns_meta" | "campaigns_google";

export interface MetricDefinition {
  key: string;
  group: MetricGroup;
  format: MetricFormat;
  /** `period`: a value over the chosen period, compared with the previous one; `snapshot`: the state now (stock, open POs). */
  kind: "period" | "snapshot";
  higherIsBetter: boolean;
  /** Has a value per day / week / month (time-series widget, sparkline). */
  series: boolean;
  /** Can be computed over a filtered set of orders (custom metric filters). */
  filterable: boolean;
  /** Readers of this page may see the number. */
  page: PageKey;
  link: MetricLink;
}

const m = (key: string, group: MetricGroup, format: MetricFormat, o: Partial<Omit<MetricDefinition, "key" | "group" | "format">> = {}): MetricDefinition => ({ key, group, format, kind: "period", higherIsBetter: true, series: true, filterable: true, page: "analytics", link: "pnl", ...o });

export const METRICS: readonly MetricDefinition[] = [
  m("net_revenue", "finance", "money"),
  m("gross_revenue", "finance", "money"),
  m("orders", "finance", "number", { link: "orders" }),
  m("aov", "finance", "money"),
  m("ad_spend", "finance", "money", { higherIsBetter: false, link: "campaigns" }),
  m("cogs", "finance", "money", { higherIsBetter: false }),
  m("gross_margin", "finance", "money"),
  m("shipping", "finance", "money", { higherIsBetter: false }),
  m("fees", "finance", "money", { higherIsBetter: false }),
  m("fixed_costs", "finance", "money", { higherIsBetter: false, filterable: false }),
  m("contribution", "finance", "money"),
  m("operating_profit", "finance", "money", { filterable: false }),
  m("refunds", "finance", "money", { higherIsBetter: false }),
  m("new_customers", "customers", "number", { series: false, filterable: false, link: "customers" }),
  m("mer", "finance", "ratio"),
  m("nc_roas", "finance", "ratio", { series: false, filterable: false }),
  m("cac", "finance", "money", { higherIsBetter: false, series: false, filterable: false }),
  m("poas", "finance", "ratio"),
  m("cancel_rate", "orders", "percent", { higherIsBetter: false, link: "orders_cancelled" }),
  m("returns_rate", "orders", "percent", { higherIsBetter: false, link: "returns" }),
  m("return_cost", "orders", "money", { higherIsBetter: false, link: "returns" }),
  m("repeat_customer_rate", "customers", "percent", { series: false, filterable: false, link: "customers" }),
  m("stock_value_cost", "inventory", "money", { kind: "snapshot", series: false, filterable: false, higherIsBetter: false, page: "inventory", link: "inventory" }),
  m("coverage_days", "inventory", "days", { kind: "snapshot", series: false, filterable: false, page: "inventory", link: "inventory" }),
  m("out_of_stock_variants", "inventory", "number", { kind: "snapshot", series: false, filterable: false, higherIsBetter: false, page: "inventory", link: "inventory" }),
  m("incoming_po_value", "inventory", "money", { kind: "snapshot", series: false, filterable: false, page: "purchasing", link: "purchasing" }),
  ...(["meta", "google"] as const).flatMap((p) => [
    m(`${p}_spend`, "ads", "money", { series: false, filterable: false, higherIsBetter: false, page: "campaigns", link: `campaigns_${p}` }),
    m(`${p}_roas`, "ads", "ratio", { series: false, filterable: false, page: "campaigns", link: `campaigns_${p}` }),
    m(`${p}_cpa`, "ads", "money", { series: false, filterable: false, higherIsBetter: false, page: "campaigns", link: `campaigns_${p}` }),
    m(`${p}_ctr`, "ads", "percent", { series: false, filterable: false, page: "campaigns", link: `campaigns_${p}` }),
  ]),
];
export const METRIC_KEYS = METRICS.map((d) => d.key);
const METRIC_BY_KEY = new Map(METRICS.map((d) => [d.key, d]));
export function metricDefinition(key: string): MetricDefinition | null {
  return METRIC_BY_KEY.get(key) ?? null;
}
/** Bases a filtered custom metric may use: everything computed from the filtered orders (ad spend only with a campaign or platform filter). */
export const FILTERABLE_METRIC_KEYS = METRICS.filter((d) => d.filterable).map((d) => d.key);
export const SERIES_METRIC_KEYS = METRICS.filter((d) => d.series).map((d) => d.key);

export const CUSTOM_METRIC_PREFIX = "custom:";
export const isCustomMetricRef = (ref: string) => ref.startsWith(CUSTOM_METRIC_PREFIX);

export const metricFiltersSchema = z
  .object({
    /** Attribution channel (`paid_social`, `organic_search`, …) as recorded on the order. */
    channel: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    country: z.array(z.string().trim().length(2).toUpperCase()).max(40).optional(),
    paymentMethod: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
    productIds: z.array(z.string().uuid()).max(50).optional(),
    /** The product type stands in for a collection: Keel stores no collections. */
    productType: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    campaignIds: z.array(z.string().uuid()).max(50).optional(),
    platform: z.array(z.string().trim().min(1).max(20)).max(6).optional(),
    customerType: z.enum(["new", "returning"]).optional(),
  })
  .strict();
export type MetricFilters = z.infer<typeof metricFiltersSchema>;

/** Empty arrays and missing keys mean "no filter"; returns null when nothing filters. */
export function normalizeMetricFilters(raw: unknown): MetricFilters | null {
  const parsed = metricFiltersSchema.safeParse(raw ?? {});
  if (!parsed.success) return null;
  const out: MetricFilters = {};
  for (const [k, v] of Object.entries(parsed.data) as [keyof MetricFilters, unknown][]) {
    if (Array.isArray(v) ? v.length > 0 : v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- periods ---------- */

export const DASHBOARD_PERIODS = ["today", "7d", "30d", "90d", "mtd", "last_month", "ytd"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "30d";

/* ---------- widget catalog ---------- */

export const WIDGET_WIDTHS = [1, 2, 3, 4] as const;
export const WIDGET_HEIGHTS = [1, 2, 3, 4] as const;
export type WidgetWidth = (typeof WIDGET_WIDTHS)[number];
export type WidgetHeight = (typeof WIDGET_HEIGHTS)[number];
/** Most widgets a dashboard may hold; each one is a parallel request. */
export const DASHBOARD_WIDGET_CAP = 24;
export const DASHBOARD_LAYOUT_VERSION = 2;

const title = z.string().trim().max(80).optional();
const metricRef = z.string().trim().min(1).max(60);
export const BREAKDOWN_DIMENSIONS = ["channel", "country", "payment_method", "product", "campaign", "platform"] as const;
export const BREAKDOWN_METRICS = ["net_revenue", "orders", "contribution", "ad_spend"] as const;
export const TOP_LIST_ENTITIES = ["products", "campaigns", "customers", "ads", "keywords", "search_terms"] as const;
export type TopListEntity = (typeof TOP_LIST_ENTITIES)[number];
/** Page a top list needs: ads, keywords and search terms live under Campaigns (issue #40). */
export const TOP_LIST_PAGE: Record<TopListEntity, PageKey> = { products: "products", campaigns: "campaigns", customers: "customers", ads: "campaigns", keywords: "campaigns", search_terms: "campaigns" };
export const SERIES_GRANULARITIES = ["day", "week", "month"] as const;

const empty = z.object({}).strip();
export const WIDGET_SETTINGS = {
  kpi: z.object({ metric: metricRef.default("net_revenue"), compare: z.enum(["previous", "none"]).default("previous"), sparkline: z.boolean().default(true), title }),
  timeseries: z.object({ metrics: z.array(metricRef).min(1).max(3).default(["net_revenue"]), chart: z.enum(["line", "bar"]).default("line"), granularity: z.enum(SERIES_GRANULARITIES).default("day"), title }),
  breakdown: z.object({ metric: z.enum(BREAKDOWN_METRICS).default("net_revenue"), by: z.enum(BREAKDOWN_DIMENSIONS).default("channel"), limit: z.number().int().min(3).max(20).default(8), title }),
  top_list: z.object({ entity: z.enum(TOP_LIST_ENTITIES).default("products"), limit: z.number().int().min(3).max(20).default(5), title }),
  target: z.object({ metric: metricRef.default("net_revenue"), title }),
  alerts: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
  note: z.object({ title, markdown: z.string().max(4000).default(""), translations: z.record(z.string().max(10), z.string().max(4000)).default({}) }),
  queue_review: empty,
  queue_late: empty,
  queue_awaiting_stock: empty,
  queue_exceptions: empty,
  queue_integrations: empty,
  today_kpis: empty,
  sales_30d: empty,
  month_forecast: empty,
  work_queue: empty,
  stock_backorders: empty,
  today_by_status: empty,
  cod_queue: empty,
} as const;
export type WidgetType = keyof typeof WIDGET_SETTINGS;
export type WidgetSettings<T extends WidgetType> = z.infer<(typeof WIDGET_SETTINGS)[T]>;

export interface WidgetDefinition {
  type: WidgetType;
  group: "metrics" | "charts" | "lists" | "queues" | "content" | "keel";
  widths: readonly WidgetWidth[];
  defaultWidth: WidgetWidth;
  defaultHeight: WidgetHeight;
  /** Page the viewer's role must be able to open; metric widgets also check each metric's page. */
  page: PageKey;
  /** Module or add-on the tenant must have; the widget is never offered (and its data refused) otherwise. */
  module: ModuleKey | null;
  /** Reads the dashboard (or its own) period. */
  usesPeriod: boolean;
}

const d = (type: WidgetType, group: WidgetDefinition["group"], page: PageKey, o: Partial<Omit<WidgetDefinition, "type" | "group" | "page">> = {}): WidgetDefinition => ({ type, group, page, widths: [1, 2], defaultWidth: 1, defaultHeight: 1, module: null, usesPeriod: false, ...o });

export const WIDGETS: Record<WidgetType, WidgetDefinition> = {
  kpi: d("kpi", "metrics", "dashboard", { usesPeriod: true }),
  timeseries: d("timeseries", "charts", "dashboard", { widths: [2, 3, 4], defaultWidth: 2, defaultHeight: 2, usesPeriod: true }),
  breakdown: d("breakdown", "charts", "dashboard", { widths: [1, 2, 3, 4], defaultWidth: 2, defaultHeight: 2, usesPeriod: true }),
  top_list: d("top_list", "lists", "dashboard", { widths: [1, 2, 3, 4], defaultHeight: 2, usesPeriod: true }),
  target: d("target", "metrics", "dashboard"),
  alerts: d("alerts", "lists", "analytics", { defaultHeight: 2 }),
  note: d("note", "content", "dashboard", { widths: [1, 2, 3, 4], defaultWidth: 2 }),
  queue_review: d("queue_review", "queues", "orders", { module: "core.orders" }),
  queue_late: d("queue_late", "queues", "orders", { module: "core.orders" }),
  queue_awaiting_stock: d("queue_awaiting_stock", "queues", "orders", { module: "core.orders" }),
  queue_exceptions: d("queue_exceptions", "queues", "shipments", { module: "core.shipments" }),
  queue_integrations: d("queue_integrations", "queues", "integrations", { module: "core.platform" }),
  // Keel's home tiles: the template is made of these, so a tenant that never customises sees the same home
  today_kpis: d("today_kpis", "keel", "dashboard", { widths: [4], defaultWidth: 4 }),
  sales_30d: d("sales_30d", "keel", "dashboard", { widths: [2, 3, 4], defaultWidth: 3, defaultHeight: 4 }),
  month_forecast: d("month_forecast", "keel", "dashboard"),
  work_queue: d("work_queue", "keel", "dashboard"),
  stock_backorders: d("stock_backorders", "keel", "dashboard"),
  today_by_status: d("today_by_status", "keel", "dashboard"),
  cod_queue: d("cod_queue", "queues", "cod_queue", { module: "addon.cod" }),
};
export const WIDGET_TYPES = Object.keys(WIDGETS) as WidgetType[];

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  w: WidgetWidth;
  h: WidgetHeight;
  /** Own period; null follows the dashboard. */
  period: DashboardPeriod | null;
  settings: Record<string, unknown>;
}

export const dashboardWidgetSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  type: z.enum(WIDGET_TYPES as [WidgetType, ...WidgetType[]]),
  w: z.number().int().min(1).max(4).default(1),
  h: z.number().int().min(1).max(4).default(1),
  period: z.enum(DASHBOARD_PERIODS).nullable().default(null),
  settings: z.record(z.string(), z.unknown()).default({}),
});

/** Parses one widget: type known, size allowed for the type, settings valid for the type (defaults filled). */
export function parseWidget(raw: unknown): DashboardWidget | null {
  const base = dashboardWidgetSchema.safeParse(raw);
  if (!base.success) return null;
  const def = WIDGETS[base.data.type];
  const settings = WIDGET_SETTINGS[base.data.type].safeParse(base.data.settings);
  if (!settings.success) return null;
  const w = (def.widths as readonly number[]).includes(base.data.w) ? (base.data.w as WidgetWidth) : def.defaultWidth;
  return { id: base.data.id, type: base.data.type, w, h: base.data.h as WidgetHeight, period: def.usesPeriod ? base.data.period : null, settings: settings.data as Record<string, unknown> };
}

/**
 * Widgets of a stored layout. Version 1 (the personal "My dashboard" of Analytics) stored `[{ metric }]`:
 * each becomes a KPI tile. Version 2 stores widgets; unknown or invalid ones are dropped, never thrown.
 */
export function normalizeLayout(version: number, raw: unknown): DashboardWidget[] {
  const list = Array.isArray(raw) ? raw : [];
  if (version < 2) {
    return list
      .filter((x): x is { metric: string } => typeof x === "object" && x !== null && typeof (x as { metric?: unknown }).metric === "string")
      .slice(0, DASHBOARD_WIDGET_CAP)
      .map((x, i) => ({ id: `v1-${i}`, type: "kpi" as const, w: 1 as const, h: 1 as const, period: null, settings: { metric: x.metric, compare: "previous", sparkline: false } }));
  }
  return list.map(parseWidget).filter((x): x is DashboardWidget => x !== null).slice(0, DASHBOARD_WIDGET_CAP);
}

/** The tenant has the widget's module (core modules always; add-ons when active). */
export function isWidgetAvailable(type: WidgetType, activeAddons: readonly string[]): boolean {
  const mod = WIDGETS[type]?.module;
  if (!WIDGETS[type]) return false;
  if (!mod || !isAddonModule(mod)) return true;
  return activeAddons.includes(mod);
}

/** Widget types a tenant may add: those of its modules and add-ons. */
export function availableWidgetTypes(activeAddons: readonly string[]): WidgetType[] {
  return WIDGET_TYPES.filter((t) => isWidgetAvailable(t, activeAddons));
}

/** Metric references a widget reads (KPI, time series, target, breakdown). */
export function widgetMetricRefs(w: Pick<DashboardWidget, "type" | "settings">): string[] {
  const s = w.settings as { metric?: unknown; metrics?: unknown };
  if (w.type === "kpi" || w.type === "target" || w.type === "breakdown") return typeof s.metric === "string" ? [s.metric] : [];
  if (w.type === "timeseries") return Array.isArray(s.metrics) ? s.metrics.filter((x): x is string => typeof x === "string") : [];
  return [];
}

/**
 * Pages a metric reference needs: the base metric's page, or for a custom metric the pages of every
 * base its formula uses (`basesOf` returns null for an unknown custom metric, which needs analytics).
 */
export function metricPages(ref: string, basesOf: (customKey: string) => readonly string[] | null): PageKey[] {
  if (isCustomMetricRef(ref)) {
    const bases = basesOf(ref.slice(CUSTOM_METRIC_PREFIX.length));
    if (!bases) return ["analytics"];
    return [...new Set(bases.map((b) => metricDefinition(b)?.page ?? "analytics"))];
  }
  return [metricDefinition(ref)?.page ?? "analytics"];
}

/** A viewer sees a widget when the tenant has its module and their role opens its page and every metric's page. */
export function isWidgetVisible(w: Pick<DashboardWidget, "type" | "settings">, role: TenantRole, activeAddons: readonly string[], basesOf: (customKey: string) => readonly string[] | null): boolean {
  const def = WIDGETS[w.type];
  if (!def || !isWidgetAvailable(w.type, activeAddons)) return false;
  if (!canViewPage(role, def.page)) return false;
  // a breakdown by campaign or platform shows campaign rows
  if (w.type === "breakdown" && ["campaign", "platform"].includes(String((w.settings as { by?: unknown }).by)) && !canViewPage(role, "campaigns")) return false;
  if (w.type === "top_list") {
    const entity = String((w.settings as { entity?: unknown }).entity ?? "products");
    if (!canViewPage(role, (TOP_LIST_ENTITIES as readonly string[]).includes(entity) ? TOP_LIST_PAGE[entity as TopListEntity] : "analytics")) return false;
  }
  return widgetMetricRefs(w).every((ref) => metricPages(ref, basesOf).every((p) => canViewPage(role, p)));
}

/* ---------- dashboards ---------- */

export const DASHBOARD_SCOPES = ["tenant", "role", "personal"] as const;
export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

export const dashboardSettingsSchema = z.object({ period: z.enum(DASHBOARD_PERIODS).default(DEFAULT_DASHBOARD_PERIOD) }).strip();
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;
export function parseDashboardSettings(raw: unknown): DashboardSettings {
  const r = dashboardSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : dashboardSettingsSchema.parse({});
}

/** Who may change a dashboard: tenant and role dashboards need `manage_dashboard`; a personal one belongs to its user (while the tenant allows personal dashboards). */
export function canEditDashboard(role: TenantRole, userId: string, d: { scope: string; userId: string | null }, personalAllowed: boolean): boolean {
  if (d.scope === "personal") return personalAllowed && d.userId === userId;
  return canDo(role, "manage_dashboard");
}

/** Who may open a dashboard: personal ones only their user; role variants and extra dashboards the roles listed (none listed = everyone); managers see all tenant ones. */
export function canSeeDashboard(role: TenantRole, userId: string, d: { scope: string; userId: string | null; roles: readonly string[] }, personalAllowed: boolean): boolean {
  if (d.scope === "personal") return personalAllowed && d.userId === userId;
  if (canDo(role, "manage_dashboard")) return true;
  return d.roles.length === 0 || d.roles.includes(role);
}

/**
 * Keel's template: today's home, tile for tile. A tenant without a home dashboard of its own renders
 * it, so template updates reach every tenant that never customised; widgets of modules the tenant
 * lacks are left out.
 */
export const KEEL_TEMPLATE: readonly DashboardWidget[] = [
  { id: "keel-today", type: "today_kpis", w: 4, h: 1, period: null, settings: {} },
  { id: "keel-sales", type: "sales_30d", w: 3, h: 4, period: null, settings: {} },
  { id: "keel-forecast", type: "month_forecast", w: 1, h: 1, period: null, settings: {} },
  { id: "keel-queue", type: "work_queue", w: 1, h: 1, period: null, settings: {} },
  { id: "keel-stock", type: "stock_backorders", w: 1, h: 1, period: null, settings: {} },
  { id: "keel-status", type: "today_by_status", w: 1, h: 1, period: null, settings: {} },
];
export function keelTemplate(activeAddons: readonly string[]): DashboardWidget[] {
  return KEEL_TEMPLATE.filter((w) => isWidgetAvailable(w.type, activeAddons)).map((w) => ({ ...w, settings: { ...w.settings } }));
}

/** A fresh widget of a type with default settings and size. */
export function newWidget(type: WidgetType, id: string, settings: Record<string, unknown> = {}): DashboardWidget {
  const def = WIDGETS[type];
  return { id, type, w: def.defaultWidth, h: def.defaultHeight, period: null, settings: WIDGET_SETTINGS[type].parse(settings) as Record<string, unknown> };
}
