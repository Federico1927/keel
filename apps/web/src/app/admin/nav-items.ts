/**
 * Console navigation (#48), grouped: Overview · Tenants · Users · Billing · Operations · Support ·
 * Audit. Only pages that exist are listed (a test checks every href against the app directory);
 * job runs and failure alerts (#32) get their slot here when their pages are built; a tenant's dashboard
 * is reset from the tenant itself through impersonation (#43).
 */
export const ADMIN_NAV = [
  { group: "overview", items: [{ key: "dashboard", href: "/admin", exact: true }, { key: "metrics", href: "/admin/metrics" }] },
  { group: "tenants", items: [{ key: "tenants", href: "/admin/tenants" }, { key: "plans", href: "/admin/plans" }] },
  { group: "users", items: [{ key: "users", href: "/admin/users" }] },
  { group: "billing", items: [{ key: "billing", href: "/admin/billing", exact: true }, { key: "subscriptions", href: "/admin/billing/subscriptions" }] },
  { group: "operations", items: [{ key: "integrations", href: "/admin/integrations" }, { key: "email", href: "/admin/email" }, { key: "mcp", href: "/admin/mcp" }] },
  { group: "support", items: [{ key: "support", href: "/admin/support" }] },
  { group: "audit", items: [{ key: "audit", href: "/admin/audit" }, { key: "styleguide", href: "/admin/styleguide" }] },
] as const;

export type AdminNavKey = (typeof ADMIN_NAV)[number]["items"][number]["key"];
