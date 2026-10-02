import type { ModuleKey } from "./modules";
import type { PageKey, TenantRole } from "./roles";

/**
 * Destinations the phone's bottom navigation can hold (#49). Each one opens with its page's
 * permission (and plan module when it has one); the web app maps keys to links and icons.
 */
export interface MobileNavDestination {
  page: PageKey;
  planModule?: ModuleKey;
}

export const MOBILE_NAV_DESTINATIONS = {
  dashboard: { page: "dashboard" },
  orders: { page: "orders" },
  fulfilment: { page: "shipments" },
  shipments: { page: "shipments" },
  returns: { page: "returns" },
  tasks: { page: "tasks" },
  cod_queue: { page: "cod_queue" },
  products: { page: "products" },
  inventory: { page: "inventory" },
  stock_takes: { page: "inventory" },
  purchasing: { page: "purchasing" },
  campaigns: { page: "campaigns" },
  analytics: { page: "analytics" },
  customers: { page: "customers" },
  notifications: { page: "notifications" },
  approvals: { page: "dashboard", planModule: "core.mcp" },
  assistant: { page: "assistant" },
} as const satisfies Record<string, MobileNavDestination>;
export type MobileNavKey = keyof typeof MOBILE_NAV_DESTINATIONS;
export const MOBILE_NAV_KEYS = Object.keys(MOBILE_NAV_DESTINATIONS) as MobileNavKey[];

/** Bottom-bar slots besides "More". */
export const MOBILE_NAV_SLOTS = 4;

/** The most used destinations per role, before any tenant setting. */
export const DEFAULT_MOBILE_NAV: Record<TenantRole, MobileNavKey[]> = {
  owner: ["dashboard", "orders", "analytics", "campaigns"],
  admin: ["dashboard", "orders", "fulfilment", "products"],
  operations: ["dashboard", "orders", "fulfilment", "returns"],
  customer_care: ["dashboard", "orders", "returns", "customers"],
  marketing: ["dashboard", "campaigns", "analytics", "customers"],
  viewer: ["dashboard", "orders", "analytics", "products"],
};

/** Order used to fill free slots when the chosen destinations are not available to the user. */
const FALLBACK: MobileNavKey[] = ["dashboard", "orders", "fulfilment", "returns", "products", "campaigns", "analytics", "customers", "inventory", "tasks", "notifications"];

export function isMobileNavKey(v: unknown): v is MobileNavKey {
  return typeof v === "string" && Object.hasOwn(MOBILE_NAV_DESTINATIONS, v);
}

/**
 * The bottom-bar destinations of one user: the tenant's choice for the role when it set one, else
 * the role's default; destinations the user cannot open are dropped and the free slots filled from
 * a fixed order, so the bar never shows a page that would refuse them. Never more than the slots.
 */
export function resolveMobileNav(role: TenantRole, canOpen: (key: MobileNavKey) => boolean, tenantChoice?: readonly string[] | null): MobileNavKey[] {
  const chosen = (tenantChoice ?? []).filter(isMobileNavKey);
  const start = chosen.length > 0 ? chosen : DEFAULT_MOBILE_NAV[role];
  const out: MobileNavKey[] = [];
  for (const k of [...start, ...FALLBACK]) {
    if (out.length >= MOBILE_NAV_SLOTS) break;
    if (!out.includes(k) && canOpen(k)) out.push(k);
  }
  return out;
}
