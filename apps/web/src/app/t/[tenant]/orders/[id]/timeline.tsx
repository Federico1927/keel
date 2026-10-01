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
  if (typeof v === "object") return JSON.stringify(v);
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

export function Timeline({ events, locale, timezone }: { events: TimelineEvent[]; locale: string; timezone: string }) {
  const t = useTranslations("order_detail");
  const te = useTranslations("order_events");
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
