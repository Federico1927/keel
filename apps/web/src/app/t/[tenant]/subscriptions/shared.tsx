import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge, cn } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";

/* Shared pieces of the addon.subscriptions pages (#67). */

const TABS = [
  { key: "overview", path: "" },
  { key: "subscribers", path: "/subscribers" },
  { key: "recovery", path: "/recovery" },
  { key: "stock", path: "/stock" },
  { key: "cancellations", path: "/cancellations" },
] as const;
export type SubscriptionTab = (typeof TABS)[number]["key"];

export async function SubscriptionTabs({ tenant, active }: { tenant: string; active: SubscriptionTab }) {
  const t = await getTranslations("subscriptions.tabs");
  const base = `/t/${tenant}/subscriptions`;
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto rounded-md bg-muted p-1 text-sm" data-testid="subscription-tabs">
      {TABS.map((tab) => (
        <Link key={tab.key} href={`${base}${tab.path}`} className={cn("min-w-max flex-1 rounded-sm px-3 py-1.5 text-center", tab.key === active ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(tab.key)}</Link>
      ))}
    </nav>
  );
}

export const STATUS_VARIANT: Record<string, "success" | "warning" | "muted" | "destructive"> = { active: "success", paused: "warning", cancelled: "muted", expired: "muted", failed: "destructive" };
export const RISK_VARIANT: Record<string, "success" | "warning" | "destructive"> = { low: "success", medium: "warning", high: "destructive" };

export async function SubscriptionStatusBadge({ status }: { status: string }) {
  const t = await getTranslations("subscriptions.status");
  return <Badge variant={STATUS_VARIANT[status] ?? "muted"} data-testid="subscription-status">{t.has(status) ? t(status) : status}</Badge>;
}
export async function RiskBadge({ risk }: { risk: string | null }) {
  const t = await getTranslations("subscriptions.risk");
  if (!risk) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={RISK_VARIANT[risk] ?? "muted"}>{t(risk)}</Badge>;
}

/** "every month", "every 2 months", "every 6 weeks" in the viewer's language. */
export async function intervalFormatter() {
  const t = await getTranslations("subscriptions.interval");
  return (unit: string, count: number) => t(["day", "week", "month", "year"].includes(unit) ? unit : "month", { count });
}

export const svcOf = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
