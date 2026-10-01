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

/** Order-edit details carried in the event metadata: platform write, lineage, money to settle. */
function EditMeta({ e, money }: { e: TimelineEvent; money: (minor: number) => string }) {
  const t = useTranslations("order_detail.timeline_meta");
  const m = e.metadata;
  const parts: string[] = [];
  if (e.type === "replaces" && Array.isArray(m.replaces)) parts.push(t("replaces", { orders: (m.replaces as { name: string }[]).map((x) => x.name).join(", ") }));
  if (e.type === "replaced" && typeof m.replacedBy === "string") parts.push(t("replaced_by", { order: m.replacedBy }) + (m.cancelledOnPlatform === false ? ` ${t("not_cancelled")}` : ""));
  if (e.type === "discount_applied" && typeof m.code === "string" && typeof m.amountMinor === "number") parts.push(t("discount", { code: m.code, amount: money(m.amountMinor) }));
  const balance = typeof m.balanceMinor === "number" ? m.balanceMinor : typeof m.refundDueMinor === "number" ? -m.refundDueMinor : 0;
  if (balance > 0) parts.push(t("balance_due", { amount: money(balance) }));
  if (balance < 0) parts.push(t("balance_refund", { amount: money(-balance) }));
  if (typeof m.platform === "string" && m.platform) parts.push(t("written_to", { platform: m.platform }));
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
                  {e.actorName ?? t(e.actorType === "integration" ? "integration" : "system")} · {formatDateTime(e.createdAt, locale, timezone)}
                </span>
              </div>
              <DiffList diff={e.diff} />
              <EditMeta e={e} money={money} />
              {typeof e.metadata.note === "string" && e.metadata.note && <p className="mt-1 text-xs italic text-muted-foreground">“{e.metadata.note}”</p>}
              {typeof e.metadata.reason === "string" && e.type !== "status_changed" && <p className="text-xs text-muted-foreground">{e.metadata.reason}</p>}
            </li>
          ))}
          {events.length === 0 && <li className="text-sm text-muted-foreground">{t("no_events")}</li>}
        </ol>
      </CardContent>
    </Card>
  );
}
