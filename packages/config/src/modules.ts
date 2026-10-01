/**
 * Module registry. `core.*` modules are always on for every plan; `addon.*`
 * modules are activated per tenant by the super-admin.
 */
export const CORE_MODULES = [
  "core.orders",
  "core.shipments",
  "core.crm",
  "core.analytics",
  "core.campaigns",
  "core.products",
  "core.returns",
  "core.discounts",
  "core.purchasing",
  "core.platform",
] as const;
export type CoreModule = (typeof CORE_MODULES)[number];

export const ADDON_MODULES = [
  "addon.cod",
  "addon.customer_campaigns",
  "addon.warehouse_3pl",
  "addon.whatsapp",
  "addon.carrier_tracking",
] as const;
export type AddonModule = (typeof ADDON_MODULES)[number];
export type ModuleKey = CoreModule | AddonModule;

export interface ModuleDefinition {
  key: ModuleKey;
  /** i18n key for the module name. */
  nameKey: string;
  /** i18n key for the one-line description. */
  descriptionKey: string;
  /** `implemented` ships in this repository; `on_request` is catalog-only. */
  availability: "implemented" | "on_request";
  /** Pages unlocked by the module. */
  pages: readonly string[];
  /** Monthly price in minor units for add-ons (null for core). */
  monthlyPriceMinor: number | null;
}

export const MODULES: Record<ModuleKey, ModuleDefinition> = {
  "core.orders": { key: "core.orders", nameKey: "modules.core.orders.name", descriptionKey: "modules.core.orders.description", availability: "implemented", pages: ["orders"], monthlyPriceMinor: null },
  "core.shipments": { key: "core.shipments", nameKey: "modules.core.shipments.name", descriptionKey: "modules.core.shipments.description", availability: "implemented", pages: ["shipments"], monthlyPriceMinor: null },
  "core.crm": { key: "core.crm", nameKey: "modules.core.crm.name", descriptionKey: "modules.core.crm.description", availability: "implemented", pages: ["customers", "segments"], monthlyPriceMinor: null },
  "core.analytics": { key: "core.analytics", nameKey: "modules.core.analytics.name", descriptionKey: "modules.core.analytics.description", availability: "implemented", pages: ["analytics"], monthlyPriceMinor: null },
  "core.campaigns": { key: "core.campaigns", nameKey: "modules.core.campaigns.name", descriptionKey: "modules.core.campaigns.description", availability: "implemented", pages: ["campaigns"], monthlyPriceMinor: null },
  "core.products": { key: "core.products", nameKey: "modules.core.products.name", descriptionKey: "modules.core.products.description", availability: "implemented", pages: ["products", "inventory"], monthlyPriceMinor: null },
  "core.returns": { key: "core.returns", nameKey: "modules.core.returns.name", descriptionKey: "modules.core.returns.description", availability: "implemented", pages: ["returns"], monthlyPriceMinor: null },
  "core.discounts": { key: "core.discounts", nameKey: "modules.core.discounts.name", descriptionKey: "modules.core.discounts.description", availability: "implemented", pages: ["discounts"], monthlyPriceMinor: null },
  "core.purchasing": { key: "core.purchasing", nameKey: "modules.core.purchasing.name", descriptionKey: "modules.core.purchasing.description", availability: "implemented", pages: ["purchasing"], monthlyPriceMinor: null },
  "core.platform": { key: "core.platform", nameKey: "modules.core.platform.name", descriptionKey: "modules.core.platform.description", availability: "implemented", pages: ["integrations", "settings", "users", "audit", "notifications"], monthlyPriceMinor: null },
  "addon.cod": { key: "addon.cod", nameKey: "modules.addon.cod.name", descriptionKey: "modules.addon.cod.description", availability: "implemented", pages: ["cod_queue", "cod_settings"], monthlyPriceMinor: 19900 },
  /** Messages to segments with a control group: holdout on segments, treated/control groups, uplift. WhatsApp providers (e.g. Spoki) plug in as its channel. */
  "addon.customer_campaigns": { key: "addon.customer_campaigns", nameKey: "modules.addon.customer_campaigns.name", descriptionKey: "modules.addon.customer_campaigns.description", availability: "implemented", pages: ["customer_campaigns"], monthlyPriceMinor: 9900 },
  "addon.warehouse_3pl": { key: "addon.warehouse_3pl", nameKey: "modules.addon.warehouse_3pl.name", descriptionKey: "modules.addon.warehouse_3pl.description", availability: "on_request", pages: [], monthlyPriceMinor: null },
  "addon.whatsapp": { key: "addon.whatsapp", nameKey: "modules.addon.whatsapp.name", descriptionKey: "modules.addon.whatsapp.description", availability: "on_request", pages: [], monthlyPriceMinor: null },
  "addon.carrier_tracking": { key: "addon.carrier_tracking", nameKey: "modules.addon.carrier_tracking.name", descriptionKey: "modules.addon.carrier_tracking.description", availability: "on_request", pages: [], monthlyPriceMinor: null },
};

export function isAddonModule(key: string): key is AddonModule {
  return (ADDON_MODULES as readonly string[]).includes(key);
}

/** Which module gates a page. Pages not listed are always reachable (e.g. dashboard). */
export function moduleForPage(page: string): ModuleKey | null {
  for (const def of Object.values(MODULES)) {
    if (def.pages.includes(page)) return def.key;
  }
  return null;
}

/** A page is enabled when its module is core or an active add-on of the tenant. */
export function isPageEnabled(page: string, activeAddons: readonly string[]): boolean {
  const mod = moduleForPage(page);
  if (!mod) return true;
  if (!isAddonModule(mod)) return true;
  return activeAddons.includes(mod);
}
