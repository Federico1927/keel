import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canViewPage } from "@keel/config";
import { formatRelative } from "@keel/core";
import { sourcesNeedingAttention } from "@keel/services";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@keel/ui";
import type { TenantContext } from "@/server/tenant";

/** Dashboard widget (#32): how many integration sources are not OK (stale, idle, failing), linking to the health page. */
export async function SourceHealthWidget({ ctx }: { ctx: TenantContext }) {
  if (!canViewPage(ctx.role, "integrations")) return null;
  const t = await getTranslations("dashboard.source_health");
  const { total, problems } = await ctx.run((tx) => sourcesNeedingAttention({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  if (total === 0) return null;
  const href = `/t/${ctx.tenant.slug}/integrations`;
  return (
    <Card data-testid="source-health-widget" data-problems={problems.length}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          {t("title")}
          <Link href={href} className={`tabular text-sm font-medium ${problems.length > 0 ? "text-destructive" : "text-success"}`} data-testid="source-health-count">{problems.length === 0 ? t("all_ok", { total }) : t("not_ok", { n: problems.length, total })}</Link>
        </CardTitle>
      </CardHeader>
      {problems.length > 0 && (
        <CardContent className="space-y-1 text-sm">
          {problems.slice(0, 5).map((p) => (
            <Link key={p.source} href={`${href}#${p.source.split(":")[0]}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50">
              <span className="min-w-0 truncate font-mono text-xs">{p.source}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {p.lastSuccessAt ? formatRelative(p.lastSuccessAt, ctx.locale) : t("never")}
                <Badge variant={p.status === "error" || p.status === "stale" ? "destructive" : "warning"}>{t(`statuses.${p.status}`)}</Badge>
              </span>
            </Link>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
