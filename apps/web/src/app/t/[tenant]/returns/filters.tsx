"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { RETURN_STATUSES } from "@keel/core";
import { Input, Select, cn } from "@keel/ui";

export function ReturnFiltersBar({ basePath, filters, counts, reasons }: { basePath: string; filters: { q?: string; status?: string; reason?: string }; counts: Record<string, number>; reasons: { code: string; label: string }[] }) {
  const t = useTranslations("returns");
  const ts = useTranslations("return_status");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const apply = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) u.set(k, v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  const open = ["requested", "approved", "received", "inspected"].reduce((s, k) => s + (counts[k] ?? 0), 0);
  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => apply({ status: filters.status === "open" ? undefined : "open" })} className={cn("rounded-full border px-3 py-1 text-xs", filters.status === "open" ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t("open")} <span className="tabular opacity-70">{open}</span>
        </button>
        {RETURN_STATUSES.map((s) => (
          <button key={s} type="button" onClick={() => apply({ status: filters.status === s ? undefined : s })} className={cn("rounded-full border px-3 py-1 text-xs", filters.status === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {ts(s)} <span className="tabular opacity-70">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <form className="grid gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
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
