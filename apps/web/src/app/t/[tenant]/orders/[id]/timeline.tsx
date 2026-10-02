"use client";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@keel/ui";
import { formatDateTime } from "@keel/core";

export interface TimelineEvent {
  id: string;
  type: string;
  actorName: string | null;
  actorType: string;
  diff: Record<string, { from: unknown; to: unknown }>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") {
    const a = v as Record<string, unknown>;
    // addresses read as a line, not as JSON
    if ("address1" in a || "city" in a) return [a.name, a.address1, a.address2, [a.zip, a.city, a.province].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ");
    return JSON.stringify(v);
  }
  return String(v);
}

export function DiffList({ diff }: { diff: Record<string, { from: unknown; to: unknown }> }) {
  const keys = Object.keys(diff);
  if (keys.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {keys.map((k) => (
        <li key={k}>
          <span className="font-medium">{k}</span>: <span className="text-muted-foreground line-through">{fmtValue(diff[k]?.from)}</span> → <span>{fmtValue(diff[k]?.to)}</span>
        </li>
      ))}
    </ul>
  );
}

const BACKORDER_REASONS = ["stock_available", "wait_cancelled", "order_cancelled", "order_replaced", "order_fulfilled"];

/** Order-edit details carried in the event metadata: platform write, lineage, money to settle. */
function EditMeta({ e, money }: { e: TimelineEvent; money: (minor: number) => string }) {
  const t = useTranslations("order_detail.timeline_meta");
  const tp = useTranslations("payment_methods");
  const m = e.metadata;
  const parts: string[] = [];
  // payments (issue #27): manual payment and refund
  if (e.type === "payment_recorded" && typeof m.amountMinor === "number") {
    parts.push(t("payment", { amount: money(m.amountMinor), method: typeof m.method === "string" && tp.has(m.method) ? tp(m.method) : String(m.method ?? "") }));
    if (typeof m.outstandingMinor === "number" && m.outstandingMinor > 0) parts.push(t("payment_outstanding", { amount: money(m.outstandingMinor) }));
  }
  if (e.type === "refund_issued" && typeof m.amountMinor === "number") {
    parts.push(t("refund", { amount: money(m.amountMinor) }));
    if (typeof m.requestedMinor === "number" && m.requestedMinor !== m.amountMinor) parts.push(t("refund_capped", { amount: money(m.requestedMinor) }));
    if (Array.isArray(m.lines) && m.lines.length) parts.push((m.lines as { quantity: number; title: string; sku: string | null }[]).map((l) => `${l.quantity}× ${l.sku ?? l.title}`).join(", "));
    if (typeof m.restocked === "number" && m.restocked > 0) parts.push(t("restocked", { n: m.restocked }));
  }
  if (m.platform === "outbox") parts.push(t("queued_platform"));
  if (e.type === "replaces" && Array.isArray(m.replaces)) parts.push(t("replaces", { orders: (m.replaces as { name: string }[]).map((x) => x.name).join(", ") }));
  if (e.type === "replaced" && typeof m.replacedBy === "string") parts.push(t("replaced_by", { order: m.replacedBy }) + (m.cancelledOnPlatform === false ? ` ${t("not_cancelled")}` : ""));
  if (e.type === "discount_applied" && typeof m.code === "string" && typeof m.amountMinor === "number") parts.push(t("discount", { code: m.code, amount: money(m.amountMinor) }));
  const balance = typeof m.balanceMinor === "number" ? m.balanceMinor : typeof m.refundDueMinor === "number" ? -m.refundDueMinor : 0;
  if (balance > 0) parts.push(t("balance_due", { amount: money(balance) }));
  if (balance < 0) parts.push(t("balance_refund", { amount: money(-balance) }));
  if (typeof m.platform === "string" && m.platform && m.platform !== "outbox") parts.push(t("written_to", { platform: m.platform }));
  // backorders: what waits for which PO, and why a wait ended
  if (e.type === "backorder_created" && Array.isArray(m.lines)) for (const l of m.lines as { quantity: number; sku: string | null; title: string; poNumber: string | null; expectedAt: string | null }[]) parts.push(l.poNumber ? t("backorder_line_po", { qty: l.quantity, item: l.sku ?? l.title, po: l.poNumber, eta: l.expectedAt ?? "—" }) : t("backorder_line", { qty: l.quantity, item: l.sku ?? l.title }));
  if ((e.type === "hold_released" || e.type === "backorder_closed") && typeof m.reason === "string" && BACKORDER_REASONS.includes(m.reason)) parts.push(t(`backorder_reason.${m.reason}`));
  if (!parts.length) return null;
  return <p className="mt-1 text-xs text-muted-foreground" data-testid="event-meta">{parts.join(" · ")}</p>;
}

export function Timeline({ events, locale, timezone, currency }: { events: TimelineEvent[]; locale: string; timezone: string; currency?: string }) {
  const t = useTranslations("order_detail");
  const te = useTranslations("order_events");
  const fmt = currency ? new Intl.NumberFormat(locale, { style: "currency", currency }) : null;
  const money = (minor: number) => (fmt ? fmt.format(minor / 100) : String(minor / 100));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("timeline")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-4 border-l pl-4">
          {events.map((e) => (
            <li key={e.id} className="text-sm">
              <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border bg-card" />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{te.has(e.type) ? te(e.type) : e.type}</span>
                <span className="text-xs text-muted-foreground">
                  {e.actorName ?? t(e.actorType === "integration" ? "integration" : "system")}
                  {e.actorType === "mcp" && <> {t("via_mcp", { client: typeof e.metadata.mcpClient === "string" ? e.metadata.mcpClient : "AI" })}</>} · {formatDateTime(e.createdAt, locale, timezone)}
                </span>
              </div>
              <DiffList diff={e.diff} />
              <EditMeta e={e} money={money} />
              {typeof e.metadata.note === "string" && e.metadata.note && <p className="mt-1 text-xs italic text-muted-foreground">“{e.metadata.note}”</p>}
              {typeof e.metadata.reason === "string" && e.type !== "status_changed" && !BACKORDER_REASONS.includes(e.metadata.reason) && <p className="text-xs text-muted-foreground">{e.metadata.reason}</p>}
            </li>
          ))}
          {events.length === 0 && <li className="text-sm text-muted-foreground">{t("no_events")}</li>}
        </ol>
      </CardContent>
    </Card>
  );
}
