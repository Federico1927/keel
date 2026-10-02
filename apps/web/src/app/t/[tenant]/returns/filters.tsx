"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { RETURN_STATUSES } from "@hullwise/core";
import { Input, ScanButton, Select, cn } from "@hullwise/ui";
import { scanLabels } from "@/components/scan-labels";

export function ReturnFiltersBar({ basePath, filters, counts, reasons }: { basePath: string; filters: { q?: string; status?: string; reason?: string }; counts: Record<string, number>; reasons: { code: string; label: string }[] }) {
  const t = useTranslations("returns");
  const ts = useTranslations("return_status");
  const router = useRouter();
  const [pending, start] = useTransition();
  const tm = useTranslations("mobile.scan");
  const [q, setQ] = useState(filters.q ?? "");
  const apply = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) u.set(k, v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  const open = ["requested", "approved", "received", "inspected"].reduce((s, k) => s + (counts[k] ?? 0), 0);
  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0">
        <button type="button" onClick={() => apply({ status: filters.status === "open" ? undefined : "open" })} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9", filters.status === "open" ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("open")} <span className="tabular opacity-70">{open}</span>
        </button>
        {RETURN_STATUSES.map((s) => (
          <button key={s} type="button" onClick={() => apply({ status: filters.status === s ? undefined : s })} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9", filters.status === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {ts(s)} <span className="tabular opacity-70">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <form className="grid gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <div className="flex gap-2 sm:col-span-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
          </div>
          {/* a return label or the order number on the parcel, read with the camera (#49) */}
          <ScanButton iconOnly labels={scanLabels(tm)} onScan={(code) => { setQ(code); apply({ q: code }); }} />
        </div>
        <Select aria-label={t("columns.reason")} value={filters.reason ?? ""} onChange={(e) => apply({ reason: e.target.value || undefined })}>
          <option value="">{t("all_reasons")}</option>
          {reasons.map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </Select>
      </form>
    </div>
  );
}
