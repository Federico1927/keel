"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, Input, ScanButton, Select, cn } from "@hullwise/ui";
import { scanLabels } from "@/components/scan-labels";
import type { ProductFilters } from "@/server/queries/catalog";

export function ProductFiltersBar({ basePath, filters, types, riskCounts }: { basePath: string; filters: ProductFilters; types: string[]; riskCounts: Record<string, number> }) {
  const t = useTranslations("products");
  const tr = useTranslations("stock_risk");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const tm = useTranslations("mobile.scan");
  const apply = (patch: Partial<Record<string, string | undefined>>) => {
    const merged: Record<string, string | undefined> = { q: filters.q, type: filters.type, status: filters.status, risk: filters.risk, ...patch };
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0">
        {(["critical", "warning", "ok", "no_sales"] as const).map((r) => (
          <button key={r} type="button" onClick={() => apply({ risk: filters.risk === r ? undefined : r })} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9", filters.risk === r ? "bg-primary text-primary-foreground" : "bg-card")}>
            {tr(r)} <span className="tabular opacity-70">{riskCounts[r] ?? 0}</span>
          </button>
        ))}
      </div>
      <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <div className="flex gap-2 sm:col-span-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
          </div>
          {/* product lookup by barcode or SKU: one match opens the product (#49) */}
          <ScanButton iconOnly labels={scanLabels(tm)} onScan={(code) => { setQ(code); start(() => router.push(`${basePath}?${new URLSearchParams({ q: code, scan: "1" })}`)); }} />
        </div>
        <Select aria-label={t("columns.type")} value={filters.type ?? ""} onChange={(e) => apply({ type: e.target.value || undefined })}>
          <option value="">{t("all_types")}</option>
          {types.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Select aria-label={t("columns.status")} value={filters.status ?? ""} onChange={(e) => apply({ status: e.target.value || undefined })}>
            <option value="">{t("all_statuses")}</option>
            {["active", "draft", "archived"].map((s) => (
              <option key={s} value={s}>{t(`status.${s}`)}</option>
            ))}
          </Select>
          {(filters.q || filters.type || filters.status || filters.risk) && (
            <Button type="button" variant="ghost" size="icon" aria-label={t("clear")} onClick={() => { setQ(""); start(() => router.push(basePath)); }}>
              <X />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
