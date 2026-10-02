import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { cn } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";

/** Sub-navigation shared by the notification pages. */
export async function NotificationTabs({ ctx, active }: { ctx: TenantContext; active: "all" | "mentions" | "preferences" | "suppressions" }) {
  const t = await getTranslations("notifications.tabs");
  const base = `/t/${ctx.tenant.slug}/notifications`;
  const tabs = [
    { key: "all", href: base },
    { key: "mentions", href: `${base}/mentions` },
    { key: "preferences", href: `${base}/preferences` },
    ...(canDo(ctx.role, "manage_settings") ? [{ key: "suppressions", href: `${base}/suppressions` }] : []),
  ] as const;
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b text-sm" aria-label="notifications">
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2", active === tab.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")} data-testid={`tab-${tab.key}`}>
          {t(tab.key)}
        </Link>
      ))}
    </nav>
  );
}

/** A filter chip that is a plain link (server-rendered filters). */
export function Chip({ href, active, children, testId }: { href: string; active: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className={cn("rounded-full border px-3 py-1 text-xs", active ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>
      {children}
    </Link>
  );
}
