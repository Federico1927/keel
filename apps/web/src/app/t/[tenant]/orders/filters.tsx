"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, FilterChip, FilterPanel, Input, Select, cn } from "@hullwise/ui";
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from "@hullwise/core";
import type { OrderFilters } from "@/server/queries/orders";

const utmKey = (d: string) => `utm${d[0]!.toUpperCase()}${d.slice(1)}`;

export function OrderFiltersBar({ basePath, filters, counts, stockViews, members, drill = null }: { basePath: string; filters: OrderFilters; counts: Record<string, number>; stockViews?: { awaiting: number; ready: number }; members: { id: string; name: string }[]; drill?: { kind: "product" | "variant"; label: string } | null }) {
  const t = useTranslations("orders");
  const ts = useTranslations("order_status");
  const tp = useTranslations("payment_methods");
  const tps = useTranslations("payment_status");
  const ta = useTranslations("analytics_depth.order_filters");
  const tm = useTranslations("mobile");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");

  const apply = (patch: Partial<Record<string, string | string[] | undefined>>) => {
    const u = new URLSearchParams();
    const current: Record<string, string | string[] | undefined> = { q: filters.q, status: filters.status, payment: filters.payment, paymentStatus: filters.paymentStatus, channel: filters.channel, tag: filters.tag, from: filters.from, to: filters.to, assigned: filters.assigned, missingCost: filters.missingCost ? "1" : undefined, product: filters.product, variant: filters.variant, campaign: filters.campaign, customer: filters.customer, attrChannel: filters.attrChannel, stock: filters.stock, country: filters.country, feeSource: filters.feeSource, payout: filters.payout, ...Object.fromEntries(Object.entries(filters.utm ?? {}).map(([d, v]) => [utmKey(d), v])), sort: filters.sort };
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
  const hasFilters = Boolean(filters.q || filters.status?.length || filters.payment?.length || filters.paymentStatus?.length || filters.channel?.length || filters.tag || filters.from || filters.to || filters.assigned || filters.missingCost || filters.product || filters.variant || filters.attrChannel || filters.stock || filters.country || filters.feeSource || filters.payout || Object.keys(filters.utm ?? {}).length);
  // attribution drill-down filters set by analytics links: one removable chip each
  const attribution: { key: string; label: string; patch: Record<string, undefined> }[] = [
    ...(filters.attrChannel ? [{ key: "attrChannel", label: ta("channel", { value: filters.attrChannel }), patch: { attrChannel: undefined } }] : []),
    ...Object.entries(filters.utm ?? {}).map(([d, v]) => ({ key: utmKey(d), label: ta("utm", { dim: d, value: v ?? "" }), patch: { [utmKey(d)]: undefined } })),
    // money drill-downs (tax report, fees, payouts)
    ...(filters.country ? [{ key: "country", label: t("filters.country", { country: filters.country }), patch: { country: undefined } }] : []),
    ...(filters.feeSource ? [{ key: "feeSource", label: t(`filters.fee_${filters.feeSource}`), patch: { feeSource: undefined } }] : []),
    ...(filters.payout ? [{ key: "payout", label: t("filters.payout"), patch: { payout: undefined } }] : []),
  ];

  // filters inside the phone sheet, shown as removable chips under the button (#49)
  const sheetChips: { key: string; label: string; patch: Record<string, undefined> }[] = [
    ...(filters.payment?.length ? [{ key: "payment", label: tp(filters.payment[0]!), patch: { payment: undefined } }] : []),
    ...(filters.paymentStatus?.length ? [{ key: "paymentStatus", label: tps(filters.paymentStatus[0]!), patch: { paymentStatus: undefined } }] : []),
    ...(filters.assigned ? [{ key: "assigned", label: filters.assigned === "me" ? t("filters.assigned_me") : filters.assigned === "none" ? t("filters.assigned_none") : (members.find((m) => m.id === filters.assigned)?.name ?? t("filters.assigned")), patch: { assigned: undefined } }] : []),
    ...(filters.from ? [{ key: "from", label: `${t("filters.from")} ${filters.from}`, patch: { from: undefined } }] : []),
    ...(filters.to ? [{ key: "to", label: `${t("filters.to")} ${filters.to}`, patch: { to: undefined } }] : []),
    ...(filters.tag ? [{ key: "tag", label: `${t("filters.tag")}: ${filters.tag}`, patch: { tag: undefined } }] : []),
  ];
  const sheetCount = sheetChips.length + (filters.sort && filters.sort !== "placed_desc" ? 1 : 0);
  const chip = "shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9";

  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      {/* status views: one scrolling row on phones, wrapped from md up */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0" data-testid="status-chips">
        <button type="button" onClick={() => apply({ status: [] })} className={cn(chip, !filters.status?.length ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("all")} <span className="tabular opacity-70">{total}</span>
        </button>
        {ORDER_STATUSES.filter((s) => counts[s]).map((s) => (
          <button key={s} type="button" onClick={() => toggleStatus(s)} className={cn(chip, filters.status?.includes(s) ? "bg-primary text-primary-foreground" : "bg-card")}>
            {ts(s)} <span className="tabular opacity-70">{counts[s]}</span>
          </button>
        ))}
        {stockViews && (stockViews.awaiting > 0 || stockViews.ready > 0 || filters.stock) && (["awaiting", "ready"] as const).map((v) => (
          <button key={v} type="button" onClick={() => apply({ stock: filters.stock === v ? undefined : v })} className={cn(chip, "inline-flex items-center gap-1 border-warning/60", filters.stock === v ? "bg-warning text-warning-foreground" : "bg-warning/10")} data-testid={`view-stock-${v}`} aria-pressed={filters.stock === v}>
            {t(`views.${v}`)} <span className="tabular opacity-70">{stockViews[v]}</span>
            {filters.stock === v && <X className="h-3 w-3" />}
          </button>
        ))}
      </div>
      {(drill || filters.missingCost || attribution.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {drill && (
            <button type="button" onClick={() => apply({ product: undefined, variant: undefined })} className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs pointer-coarse:min-h-9" data-testid="filter-product">
              <span className="truncate">{t(`filters.${drill.kind}`, { name: drill.label })}</span> <X className="h-3 w-3 shrink-0" />
            </button>
          )}
          {filters.missingCost && (
            <button type="button" onClick={() => apply({ missingCost: undefined })} className="inline-flex items-center gap-1 rounded-full border border-warning/60 bg-warning/10 px-3 py-1 text-xs pointer-coarse:min-h-9" data-testid="filter-missing-cost">
              {t("filters.missing_cost")} <X className="h-3 w-3" />
            </button>
          )}
          {attribution.map((c) => (
            <button key={c.key} type="button" onClick={() => apply(c.patch)} className="inline-flex items-center gap-1 rounded-full border border-info/60 bg-info/10 px-3 py-1 text-xs pointer-coarse:min-h-9" data-testid={`filter-${c.key}`}>
              {c.label} <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q });
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
        </div>
        <Button type="submit" variant="secondary" className="shrink-0">
          {t("search")}
        </Button>
      </form>
      <FilterPanel label={tm("filters.label")} title={tm("filters.title")} doneLabel={tm("filters.done")} closeLabel={tm("close")} activeCount={sheetCount} chips={sheetChips.length > 0 ? sheetChips.map((c) => <FilterChip key={c.key} className="md:hidden" removeLabel={tm("filters.remove")} onRemove={() => apply(c.patch)} data-testid={`chip-${c.key}`}>{c.label}</FilterChip>) : undefined}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-6">
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
          <Input type="date" className="min-w-0" aria-label={t("filters.from")} defaultValue={filters.from ?? ""} onChange={(e) => apply({ from: e.target.value || undefined })} />
          <Input type="date" className="min-w-0" aria-label={t("filters.to")} defaultValue={filters.to ?? ""} onChange={(e) => apply({ to: e.target.value || undefined })} />
          <Input aria-label={t("filters.tag")} placeholder={t("filters.tag")} defaultValue={filters.tag ?? ""} onBlur={(e) => e.target.value !== (filters.tag ?? "") && apply({ tag: e.target.value || undefined })} className="min-w-0 sm:col-span-2 lg:col-span-2" />
          {hasFilters && (
            <Button type="button" variant="ghost" className="justify-self-start" onClick={() => { setQ(""); start(() => router.push(basePath)); }}>
              <X /> {t("clear_filters")}
            </Button>
          )}
        </div>
      </FilterPanel>
    </div>
  );
}
