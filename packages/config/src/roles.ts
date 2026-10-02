/** Tenant roles, ordered from most to least privileged. */
export const TENANT_ROLES = [
  "owner",
  "admin",
  "operations",
  "customer_care",
  "marketing",
  "viewer",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value);
}

/** Page keys used by navigation, route guards and the permission matrix. */
export const PAGES = [
  "dashboard",
  "orders",
  "shipments",
  "customers",
  "segments",
  "analytics",
  "campaigns",
  "products",
  "inventory",
  "purchasing",
  "returns",
  "discounts",
  "integrations",
  "settings",
  "users",
  "audit",
  "notifications",
  "tasks",
  "support",
  // add-on pages
  "cod_queue",
  "cod_settings",
  "customer_campaigns",
  "assistant",
] as const;
export type PageKey = (typeof PAGES)[number];

export const ACTIONS = [
  "view",
  "edit",
  "cancel_order",
  "change_order_state",
  "add_note",
  "assign",
  "export",
  "manage_integrations",
  "manage_users",
  "manage_settings",
  "pause_campaign",
  "receive_purchase_order",
  "approve_return",
  "create_discount",
  "edit_order",
  "record_payment",
  "refund_order",
  "export_tenant_data",
] as const;
export type ActionKey = (typeof ACTIONS)[number];

type Level = "none" | "read" | "write";

/**
 * Permission matrix: role × page → level. `owner` and `admin` have write
 * everywhere; the matrix lists the other roles explicitly (fail closed).
 */
const MATRIX: Record<Exclude<TenantRole, "owner" | "admin">, Partial<Record<PageKey, Level>>> = {
  operations: {
    dashboard: "read",
    orders: "write",
    shipments: "write",
    customers: "read",
    segments: "none",
    analytics: "read",
    campaigns: "read",
    products: "write",
    inventory: "write",
    purchasing: "write",
    returns: "write",
    discounts: "read",
    integrations: "read",
    settings: "none",
    users: "none",
    audit: "none",
    notifications: "write",
    tasks: "write",
    support: "write",
    cod_queue: "write",
    cod_settings: "none",
    customer_campaigns: "none",
    assistant: "write",
  },
  customer_care: {
    dashboard: "read",
    orders: "write",
    shipments: "read",
    customers: "write",
    segments: "none",
    analytics: "none",
    campaigns: "none",
    products: "read",
    inventory: "read",
    purchasing: "none",
    returns: "write",
    discounts: "read",
    integrations: "none",
    settings: "none",
    users: "none",
    audit: "none",
    notifications: "write",
    tasks: "write",
    support: "write",
    cod_queue: "write",
    cod_settings: "none",
    customer_campaigns: "none",
    assistant: "write",
  },
  marketing: {
    dashboard: "read",
    orders: "read",
    shipments: "none",
    customers: "read",
    segments: "write",
    analytics: "write",
    campaigns: "write",
    products: "read",
    inventory: "read",
    purchasing: "none",
    returns: "read",
    discounts: "write",
    integrations: "read",
    settings: "none",
    users: "none",
    audit: "none",
    notifications: "write",
    tasks: "write",
    support: "write",
    cod_queue: "none",
    cod_settings: "none",
    customer_campaigns: "write",
    assistant: "write",
  },
  viewer: {
    dashboard: "read",
    orders: "read",
    shipments: "read",
    customers: "read",
    segments: "read",
    analytics: "read",
    campaigns: "read",
    products: "read",
    inventory: "read",
    purchasing: "read",
    returns: "read",
    discounts: "read",
    integrations: "read",
    settings: "none",
    users: "none",
    audit: "none",
    notifications: "read",
    tasks: "read",
    support: "read",
    cod_queue: "read",
    cod_settings: "none",
    customer_campaigns: "read",
    assistant: "write",
  },
};

/** Actions that require write level on a page, and the page they belong to. */
const ACTION_PAGE: Record<ActionKey, PageKey> = {
  view: "dashboard",
  edit: "orders",
  cancel_order: "orders",
  change_order_state: "orders",
  add_note: "orders",
  assign: "orders",
  export: "segments",
  manage_integrations: "integrations",
  manage_users: "users",
  manage_settings: "settings",
  pause_campaign: "campaigns",
  receive_purchase_order: "purchasing",
  approve_return: "returns",
  create_discount: "discounts",
  /** Contact, address, lines, merge and discount on an open order (core, any payment method). */
  edit_order: "orders",
  /** Manual payment (bank transfer received, cash…) on an order with payment pending. */
  record_payment: "orders",
  /** Money refund from the order page (goodwill, price adjustment, lines with restock). */
  refund_order: "orders",
  /** Full data export of the tenant (GDPR, leaving the platform): owner only. */
  export_tenant_data: "settings",
};

/** Actions restricted to owner/admin regardless of page level. */
const ADMIN_ONLY_ACTIONS: ReadonlySet<ActionKey> = new Set([
  "manage_integrations",
  "manage_users",
  "manage_settings",
]);

/** Actions only the owner may take (an impersonating super-admin acts as owner). */
const OWNER_ONLY_ACTIONS: ReadonlySet<ActionKey> = new Set(["export_tenant_data"]);

export function pageLevel(role: TenantRole, page: PageKey): Level {
  if (role === "owner" || role === "admin") return "write";
  return MATRIX[role][page] ?? "none";
}

export function canViewPage(role: TenantRole, page: PageKey): boolean {
  return pageLevel(role, page) !== "none";
}

export function canWritePage(role: TenantRole, page: PageKey): boolean {
  return pageLevel(role, page) === "write";
}

export function canDo(role: TenantRole, action: ActionKey): boolean {
  if (OWNER_ONLY_ACTIONS.has(action)) return role === "owner";
  if (ADMIN_ONLY_ACTIONS.has(action)) return role === "owner" || role === "admin";
  if (action === "view") return true;
  return canWritePage(role, ACTION_PAGE[action]);
}

/** Roles allowed to manage members; owner can also transfer ownership. */
export function canManageRole(actor: TenantRole, target: TenantRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
