import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@hullwise/core";
import { mergeCandidates, queueItemDetail, scoreQueueItem, type ScoreFactor } from "@hullwise/addon-cod";
import { and, eq, schema } from "@hullwise/db";
import { formatMoney } from "@hullwise/core";
import type { Address } from "@hullwise/integrations";
import { EditOrderDialog } from "./edit-order";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
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
    const isOpen = ["pending", "scheduled", "unreachable"].includes(detail.item.status);
    if (!isOpen || !canWrite) return { ...detail, factors, modify: null };
    const [order] = await tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), eq(schema.orders.id, orderId))).limit(1);
    const lines = await tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenant.id), eq(schema.orderLines.orderId, orderId)));
    const catalog = await tx.select({ id: schema.productVariants.id, sku: schema.productVariants.sku, title: schema.productVariants.title, product: schema.products.title, priceMinor: schema.productVariants.priceMinor }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.isActive, true), eq(schema.products.status, "active"))).orderBy(schema.products.title).limit(600);
    const candidates = await mergeCandidates(s, orderId);
    return { ...detail, factors, modify: order ? { order, lines, catalog, candidates } : null };
  });
  if (!data) return null;
  const { item, attempts, factors, modify } = data;
  const money = (minor: number, currency = modify?.order.currency ?? ctx.tenant.currency) => formatMoney(minor, currency, ctx.locale);
  const addr = (modify?.order.shippingAddress as Address | null) ?? null;
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
        {canWrite && open && (
          <div className="flex flex-wrap gap-2">
            <OutcomeDialog slug={ctx.tenant.slug} orderId={orderId} orderName={orderName} />
            {modify && (
              <EditOrderDialog
                variant="cod"
                slug={ctx.tenant.slug}
                orderId={orderId}
                orderName={orderName}
                contact={{ customerName: modify.order.customerName ?? "", phone: modify.order.phone ?? "", email: modify.order.email ?? "" }}
                address={{ name: addr?.name ?? modify.order.customerName ?? "", address1: addr?.address1 ?? "", address2: addr?.address2 ?? "", city: addr?.city ?? modify.order.shippingCity ?? "", province: addr?.province ?? "", zip: addr?.zip ?? modify.order.shippingZip ?? "", country: addr?.country ?? modify.order.shippingCountry ?? "" }}
                note={modify.order.note ?? ""}
                lines={modify.lines.filter((l) => l.currentQuantity > 0).map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor }))}
                catalog={modify.catalog.map((v) => ({ id: v.id, label: `${v.sku ? `${v.sku} · ` : ""}${v.product} ${v.title}`.trim(), priceMinor: v.priceMinor }))}
                mergeCandidates={modify.candidates.map((m) => ({ id: m.id, name: m.name, total: money(m.totalMinor, m.currency), lines: m.lines.map((l) => `${l.quantity}× ${l.title}${l.variantTitle ? ` ${l.variantTitle}` : ""}`).join(", ") }))}
                paid={false}
                currency={modify.order.currency}
                locale={ctx.locale}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
