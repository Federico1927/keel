import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatNumber } from "@hullwise/core";
import type { CodMineData, CodOperatorsData, CodPendingData } from "@hullwise/addon-cod";
import { Card, CardContent, CardHeader, CardTitle, cn } from "@hullwise/ui";

/** Home widgets of the COD add-on (C.10); the data is refused server-side for tenants without it. */
export async function CodWidget({ type, data, base, locale }: { type: "cod_pending" | "cod_operators" | "cod_mine"; data: unknown; base: string; locale: string }) {
  const t = await getTranslations("cod.widgets");
  const td = await getTranslations("dashboards");
  const n = (v: number) => formatNumber(v, locale);
  if (type === "cod_pending") {
    const d = data as CodPendingData;
    return (
      <Link href={`${base}/${d.path}`} className="flex h-full flex-col justify-between rounded-lg border bg-card p-(--density-stat) shadow-sm transition-colors hover:bg-muted/40" data-testid="widget-cod_pending">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{td("widget_types.cod_pending.name")}</p>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {(["today", "yesterday", "week"] as const).map((k) => (
            <div key={k}><span className={cn("block text-2xl font-semibold tabular", k === "today" && d.today > 0 && "text-primary")} data-testid={`cod-pending-${k}`}>{n(d[k])}</span><span className="text-xs text-muted-foreground">{t(`pending.${k}`)}</span></div>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("pending.total", { n: d.total })}</p>
      </Link>
    );
  }
  if (type === "cod_mine") {
    const d = data as CodMineData;
    return (
      <Link href={`${base}/${d.path}`} className="flex h-full flex-col justify-between rounded-lg border bg-card p-(--density-stat) shadow-sm transition-colors hover:bg-muted/40" data-testid="widget-cod_mine">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{td("widget_types.cod_mine.name")}</p>
        <p className="mt-1 text-2xl font-semibold tabular" data-testid="cod-mine-to-call">{n(d.toCall)}</p>
        <p className="text-xs text-muted-foreground">{[t("mine.call_backs", { n: d.callBacksDue }), t("mine.never", { n: d.neverContacted }), t("mine.planned", { n: d.planned }), t("mine.unreachable", { n: d.unreachable })].join(" · ")}</p>
      </Link>
    );
  }
  const d = data as CodOperatorsData;
  return (
    <Card className="flex h-full flex-col" data-testid="widget-cod_operators">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="truncate text-base">{td("widget_types.cod_operators.name")}</CardTitle>
        <Link href={`${base}/${d.path}`} className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline">{td("widget.open_list")}</Link>
      </CardHeader>
      <CardContent className="flex-1">
        {d.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("operators.empty")}</p> : (
          <ul className="space-y-1 text-sm">
            {d.rows.map((r) => (
              <li key={r.userId ?? "none"} className="flex items-center justify-between gap-2" data-testid="cod-operator-row">
                <span className={cn("truncate", !r.userId && "text-muted-foreground")}>{r.userId ? <Link href={`${base}/cod/team?tab=attribution&operator=${r.userId}`} className="hover:underline">{r.name}</Link> : t("operators.unassigned")}</span>
                <span className="shrink-0 tabular">{n(r.toCall)}{r.overdue > 0 && <span className="ml-1 text-xs text-destructive">{t("operators.overdue", { n: r.overdue })}</span>}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
