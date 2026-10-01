"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, Input, Select, cn } from "@keel/ui";
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from "@keel/core";
import type { OrderFilters } from "@/server/queries/orders";

const utmKey = (d: string) => `utm${d[0]!.toUpperCase()}${d.slice(1)}`;

export function OrderFiltersBar({ basePath, filters, counts, members, drill = null }: { basePath: string; filters: OrderFilters; counts: Record<string, number>; members: { id: string; name: string }[]; drill?: { kind: "product" | "variant"; label: string } | null }) {
  const t = useTranslations("orders");
  const ts = useTranslations("order_status");
  const tp = useTranslations("payment_methods");
  const tps = useTranslations("payment_status");
  const ta = useTranslations("analytics_depth.order_filters");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");

  const apply = (patch: Partial<Record<string, string | string[] | undefined>>) => {
    const u = new URLSearchParams();
    const current: Record<string, string | string[] | undefined> = { q: filters.q, status: filters.status, payment: filters.payment, paymentStatus: filters.paymentStatus, channel: filters.channel, tag: filters.tag, from: filters.from, to: filters.to, assigned: filters.assigned, missingCost: filters.missingCost ? "1" : undefined, product: filters.product, variant: filters.variant, campaign: filters.campaign, customer: filters.customer, attrChannel: filters.attrChannel, ...Object.fromEntries(Object.entries(filters.utm ?? {}).map(([d, v]) => [utmKey(d), v])), sort: filters.sort };
    const merged = { ...current, ...patch };
    for (const [k, v] of Object.entries(merged)) {
      if (!v || (Array.isArray(v) && v.length === 0)) continue;
      if (k === "sort" && v === "placed_desc") continue;
      u.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  const toggleStatus = (s: string) => {
    const cur = filters.status ?? [];
    apply({ status: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const hasFilters = Boolean(filters.q || filters.status?.length || filters.payment?.length || filters.paymentStatus?.length || filters.channel?.length || filters.tag || filters.from || filters.to || filters.assigned || filters.missingCost || filters.product || filters.variant || filters.attrChannel || Object.keys(filters.utm ?? {}).length);
  // attribution drill-down filters set by analytics links: one removable chip each
  const attribution: { key: string; label: string; patch: Record<string, undefined> }[] = [
    ...(filters.attrChannel ? [{ key: "attrChannel", label: ta("channel", { value: filters.attrChannel }), patch: { attrChannel: undefined } }] : []),
    ...Object.entries(filters.utm ?? {}).map(([d, v]) => ({ key: utmKey(d), label: ta("utm", { dim: d, value: v ?? "" }), patch: { [utmKey(d)]: undefined } })),
  ];

  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="flex flex-wrap gap-2 overflow-x-auto pb-1">
        <button type="button" onClick={() => apply({ status: [] })} className={cn("rounded-full border px-3 py-1 text-xs", !filters.status?.length ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("all")} <span className="tabular opacity-70">{total}</span>
        </button>
        {ORDER_STATUSES.filter((s) => counts[s]).map((s) => (
          <button key={s} type="button" onClick={() => toggleStatus(s)} className={cn("rounded-full border px-3 py-1 text-xs", filters.status?.includes(s) ? "bg-primary text-primary-foreground" : "bg-card")}>
            {ts(s)} <span className="tabular opacity-70">{counts[s]}</span>
          </button>
        ))}
        {drill && (
          <button type="button" onClick={() => apply({ product: undefined, variant: undefined })} className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs" data-testid="filter-product">
            <span className="truncate">{t(`filters.${drill.kind}`, { name: drill.label })}</span> <X className="h-3 w-3 shrink-0" />
          </button>
        )}
        {filters.missingCost && (
          <button type="button" onClick={() => apply({ missingCost: undefined })} className="inline-flex items-center gap-1 rounded-full border border-warning/60 bg-warning/10 px-3 py-1 text-xs" data-testid="filter-missing-cost">
            {t("filters.missing_cost")} <X className="h-3 w-3" />
          </button>
        )}
        {attribution.map((c) => (
          <button key={c.key} type="button" onClick={() => apply(c.patch)} className="inline-flex items-center gap-1 rounded-full border border-info/60 bg-info/10 px-3 py-1 text-xs" data-testid={`filter-${c.key}`}>
            {c.label} <X className="h-3 w-3" />
          </button>
        ))}
      </div>
      <form
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q });
        }}
      >
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
        </div>
        <Select aria-label={t("filters.payment")} value={filters.payment?.[0] ?? ""} onChange={(e) => apply({ payment: e.target.value ? [e.target.value] : [] })}>
          <option value="">{t("filters.payment")}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {tp(m)}
            </option>
          ))}
        </Select>
        <Select aria-label={t("filters.payment_status")} value={filters.paymentStatus?.[0] ?? ""} onChange={(e) => apply({ paymentStatus: e.target.value ? [e.target.value] : [] })}>
          <option value="">{t("filters.payment_status")}</option>
          {PAYMENT_STATUSES.map((m) => (
            <option key={m} value={m}>
              {tps(m)}
            </option>
          ))}
        </Select>
        <Select aria-label={t("filters.assigned")} value={filters.assigned ?? ""} onChange={(e) => apply({ assigned: e.target.value || undefined })}>
          <option value="">{t("filters.assigned")}</option>
          <option value="me">{t("filters.assigned_me")}</option>
          <option value="none">{t("filters.assigned_none")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select aria-label={t("filters.sort")} value={filters.sort ?? "placed_desc"} onChange={(e) => apply({ sort: e.target.value })}>
          <option value="placed_desc">{t("sort.placed_desc")}</option>
          <option value="placed_asc">{t("sort.placed_asc")}</option>
          <option value="total_desc">{t("sort.total_desc")}</option>
        </Select>
        <div className="flex gap-2 lg:col-span-3">
          <Input type="date" aria-label={t("filters.from")} defaultValue={filters.from ?? ""} onChange={(e) => apply({ from: e.target.value || undefined })} />
          <Input type="date" aria-label={t("filters.to")} defaultValue={filters.to ?? ""} onChange={(e) => apply({ to: e.target.value || undefined })} />
          <Input aria-label={t("filters.tag")} placeholder={t("filters.tag")} defaultValue={filters.tag ?? ""} onBlur={(e) => e.target.value !== (filters.tag ?? "") && apply({ tag: e.target.value || undefined })} />
        </div>
        <div className="flex items-center gap-2 lg:col-span-3 lg:justify-end">
          <Button type="submit" variant="secondary" size="sm">
            {t("search")}
          </Button>
          {hasFilters && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { setQ(""); start(() => router.push(basePath)); }}>
              <X /> {t("clear_filters")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
