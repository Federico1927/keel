import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@keel/core";
import { queueItemDetail, scoreQueueItem, type ScoreFactor } from "@keel/addon-cod";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@keel/ui";
import type { TenantContext } from "@/server/tenant";
import { OutcomeDialog, ScoreBadge } from "../../cod/queue-controls";

/** Shown on COD orders when addon.cod is active: explained score, attempts, outcome button. */
export async function CodCard({ ctx, orderId, orderName, canWrite }: { ctx: TenantContext; orderId: string; orderName: string; canWrite: boolean }) {
  const t = await getTranslations("cod");
  const tf = await getTranslations("cod.factors");
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const detail = await queueItemDetail(s, orderId);
    if (!detail) return null;
    const breakdown = detail.item.scoreBreakdown as { base?: number; factors?: ScoreFactor[] };
    const factors = breakdown.factors ?? (await scoreQueueItem(s, orderId, { timezone: ctx.tenant.timezone })).factors;
    return { ...detail, factors };
  });
  if (!data) return null;
  const { item, attempts, factors } = data;
  const open = ["pending", "scheduled", "unreachable"].includes(item.status);
  const sorted = [...factors].sort((a, b) => Number(b.contributes) - Number(a.contributes) || b.weight - a.weight);
  const sev = (s: string) => (s === "critical" ? "destructive" : s === "warning" ? "warning" : s === "positive" ? "success" : "muted") as "destructive" | "warning" | "success" | "muted";
  return (
    <Card data-testid="cod-card">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{t("card_title")}</CardTitle>
          <CardDescription>{t(`queue_status.${item.status}`)}{item.callBackAt ? ` · ${t("call_back_badge", { at: formatDateTime(item.callBackAt, ctx.locale, ctx.tenant.timezone) })}` : ""}</CardDescription>
        </div>
        <ScoreBadge score={item.score} tier={item.riskTier} />
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ul className="space-y-1">
          {sorted.map((f) => (
            <li key={f.key} className="flex items-start justify-between gap-2">
              <span className={f.contributes ? "" : "text-muted-foreground"}>
                <Badge variant={sev(f.severity)} className="mr-2">{f.raw === null ? "—" : f.raw}</Badge>
                {tf(`${f.key}.name`)} <span className="text-xs text-muted-foreground">· {t("weight_n", { n: f.weight })}{f.contributes ? "" : ` · ${t("informational")}`}</span>
              </span>
              <span className="max-w-[12rem] truncate text-right text-xs text-muted-foreground" title={JSON.stringify(f.detail)}>{Object.entries(f.detail).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : String(v)}`).join(" · ")}</span>
            </li>
          ))}
        </ul>
        {attempts.length > 0 && (
          <div>
            <p className="mb-1 font-medium">{t("attempts_title", { n: attempts.length })}</p>
            <ul className="space-y-1 text-xs">
              {attempts.map(({ a, operator, operatorEmail }) => (
                <li key={a.id} className="flex flex-wrap gap-2"><span className="tabular text-muted-foreground">{formatDateTime(a.createdAt, ctx.locale, ctx.tenant.timezone)}</span><Badge variant="outline">#{a.attemptNumber}</Badge><span>{t(`outcomes.${a.outcome}`)}</span><span className="text-muted-foreground">{operator ?? operatorEmail ?? ""}</span>{a.note && <span className="text-muted-foreground">· {a.note}</span>}</li>
              ))}
            </ul>
          </div>
        )}
        {canWrite && open && <OutcomeDialog slug={ctx.tenant.slug} orderId={orderId} orderName={orderName} />}
      </CardContent>
    </Card>
  );
}
