/**
 * Console navigation (#48), grouped: Overview · Tenants · Users · Billing · Operations · Support ·
 * Audit. Only pages that exist are listed (a test checks every href against the app directory);
 * Dashboard reset (#43) is done from the tenant itself through impersonation.
 */
export const ADMIN_NAV = [
  { group: "overview", items: [{ key: "dashboard", href: "/admin", exact: true }, { key: "metrics", href: "/admin/metrics" }] },
  { group: "tenants", items: [{ key: "tenants", href: "/admin/tenants" }, { key: "plans", href: "/admin/plans" }] },
  { group: "users", items: [{ key: "users", href: "/admin/users" }] },
  { group: "billing", items: [{ key: "billing", href: "/admin/billing" }] },
  { group: "operations", items: [{ key: "integrations", href: "/admin/integrations" }, { key: "email", href: "/admin/email" }, { key: "mcp", href: "/admin/mcp" }, { key: "jobs", href: "/admin/jobs" }, { key: "alerts", href: "/admin/alerts" }] },
  { group: "support", items: [{ key: "support", href: "/admin/support" }] },
  { group: "audit", items: [{ key: "audit", href: "/admin/audit" }, { key: "styleguide", href: "/admin/styleguide" }] },
] as const;

export type AdminNavKey = (typeof ADMIN_NAV)[number]["items"][number]["key"];
