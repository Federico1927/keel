import type { ModuleKey } from "@hullwise/config";

/**
 * Claim registry (#47): every product feature the landing names maps to the module keys of
 * @hullwise/config that deliver it. `claims.test.ts` checks the keys exist and are built, that plan cards
 * follow `isModuleInPlan`, that add-ons match the add-on modules and their prices, and that features
 * still being built appear only under "Coming soon". Adding a claim to the page means adding it here.
 *
 * `kind: "service"` marks a commitment of the team (setup, support), `kind: "commercial"` a contract
 * term: neither is a module, both are listed so the test can tell them from a forgotten mapping.
 */
export type Claim =
  { kind: "module"; modules: readonly ModuleKey[] } | { kind: "service" } | { kind: "commercial" };

const mod = (...modules: ModuleKey[]): Claim => ({ kind: "module", modules });

/** Modules carousel, in display order (the differentiator first). `shot` is the capture name. */
export const MODULE_SLIDES = [
  { key: "campaigns", shot: "campaigns", claim: mod("core.campaigns") },
  { key: "analytics", shot: "analytics-pl", claim: mod("core.analytics") },
  { key: "assistant", shot: "assistant", claim: mod("core.analytics") },
  { key: "orders", shot: "orders", claim: mod("core.orders") },
  { key: "shipments", shot: "shipments", claim: mod("core.shipments") },
  { key: "inventory", shot: "inventory", claim: mod("core.products") },
  { key: "purchasing", shot: "purchasing", claim: mod("core.purchasing") },
  { key: "returns", shot: "returns", claim: mod("core.returns") },
  { key: "discounts", shot: "discounts", claim: mod("core.discounts") },
  { key: "crm", shot: "rfm", claim: mod("core.crm") },
] as const;

/** "Also included" grid under the carousel. `fromPlan` renders a "From <plan>" badge. */
export const EXTRA_FEATURES = [
  { key: "dashboards", claim: mod("core.analytics") },
  { key: "mcp", claim: mod("core.mcp"), fromPlan: "growth" },
  { key: "tiktok", claim: mod("core.ads.tiktok"), fromPlan: "growth" },
  { key: "money", claim: mod("core.analytics") },
  { key: "lists", claim: mod("core.platform") },
  { key: "health", claim: mod("core.platform") },
  { key: "roles", claim: mod("core.platform") },
] as const;

/** Plan card lines (`pricing.features.<id>`), plus the lines every card shows. */
export const PLAN_FEATURE_CLAIMS: Record<string, Claim> = {
  orders_shipments: mod("core.orders", "core.shipments"),
  products_purchasing: mod("core.products", "core.purchasing"),
  returns_discounts: mod("core.returns", "core.discounts"),
  analytics_pnl: mod("core.analytics"),
  campaigns_stock: mod("core.campaigns"),
  crm_segments_rfm: mod("core.crm"),
  ai_assistant: mod("core.analytics"),
  mcp: mod("core.mcp"),
  tiktok_ads: mod("core.ads.tiktok"),
  /** Audit log and unlimited users: users, roles and audit live in the platform module. */
  audit_retention: mod("core.platform"),
  unlimited_users: mod("core.platform"),
  priority_support: { kind: "service" },
  enterprise_volume: { kind: "commercial" },
  enterprise_sla: { kind: "commercial" },
  enterprise_custom: { kind: "service" },
};

/** Add-on cards (`ADDONS` in pricing.ts) → add-on modules. Tailored work maps to the catalog slots. */
export const ADDON_CLAIMS: Record<string, Claim> = {
  customer_campaigns: mod("addon.customer_campaigns"),
  subscriptions: mod("addon.subscriptions"),
  cod: mod("addon.cod"),
  whatsapp_spoki: mod("addon.whatsapp_spoki"),
  custom_integration: mod("addon.warehouse_3pl", "addon.carrier_tracking"),
  custom_development: { kind: "service" },
};

/** FAQ answers, in display order (`faq.items.<key>`). */
export const FAQ_CLAIMS = {
  payments: mod("core.orders", "addon.cod"),
  contracts: { kind: "commercial" },
  setup: { kind: "service" },
  security: mod("core.platform"),
  export: mod("core.platform"),
  ai: mod("core.analytics"),
  mcp: mod("core.mcp"),
  overage: { kind: "commercial" },
  languages: mod("core.platform"),
} as const satisfies Record<string, Claim>;

/** "How it works" steps (`how.steps.<key>`). */
export const HOW_CLAIMS = {
  connect: mod("core.platform"),
  configure: { kind: "service" },
  operate: mod("core.platform"),
} as const satisfies Record<string, Claim>;

/** The Hullwise column of the comparison (`comparison.hullwise_items.<key>`). */
export const COMPARISON_CLAIMS = {
  model: mod("core.orders", "core.analytics"),
  users: mod("core.platform"),
  setup: { kind: "service" },
  contract: { kind: "commercial" },
  addons: mod("addon.customer_campaigns", "addon.cod"),
} as const satisfies Record<string, Claim>;

/** Features being built: shown only in the labelled "Coming soon" block, with their issue. */
export const COMING_SOON: readonly { key: string; issue: number }[] = [];
