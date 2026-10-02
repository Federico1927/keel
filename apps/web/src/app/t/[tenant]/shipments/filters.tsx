"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, Input, Select, cn } from "@hullwise/ui";
import { SHIPMENT_STATUSES } from "@hullwise/core";
import type { ShipmentFilters } from "@/server/queries/shipments";

export function ShipmentFiltersBar({ basePath, filters, carriers }: { basePath: string; filters: ShipmentFilters; carriers: string[] }) {
  const t = useTranslations("shipments");
  const ts = useTranslations("shipment_status");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const apply = (patch: Partial<Record<string, string | string[] | undefined>>) => {
    const merged: Record<string, string | string[] | undefined> = { status: filters.status, carrier: filters.carrier, view: filters.view === "all" ? undefined : filters.view, q: filters.q, ...patch };
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v && !(Array.isArray(v) && v.length === 0)) u.set(k, Array.isArray(v) ? v.join(",") : v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  const views: ShipmentFilters["view"][] = ["all", "open", "stuck", "exceptions"];
  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="flex flex-wrap gap-2">
        {views.map((v) => (
          <button key={v} type="button" onClick={() => apply({ view: v, status: [] })} className={cn("rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9", (filters.view ?? "all") === v && !filters.status?.length ? "bg-primary text-primary-foreground" : "bg-card")}>
            {t(`views.${v}`)}
          </button>
        ))}
      </div>
      <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
        </div>
        <Select aria-label={t("filters.status")} value={filters.status?.[0] ?? ""} onChange={(e) => apply({ status: e.target.value ? [e.target.value] : [], view: undefined })}>
          <option value="">{t("filters.status")}</option>
          {SHIPMENT_STATUSES.map((s) => (
            <option key={s} value={s}>{ts(s)}</option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Select aria-label={t("filters.carrier")} value={filters.carrier ?? ""} onChange={(e) => apply({ carrier: e.target.value || undefined })}>
            <option value="">{t("filters.carrier")}</option>
            {carriers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
          {(filters.q || filters.status?.length || filters.carrier || (filters.view && filters.view !== "all")) && (
            <Button type="button" variant="ghost" size="icon" aria-label={t("clear")} onClick={() => { setQ(""); start(() => router.push(basePath)); }}>
              <X />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
