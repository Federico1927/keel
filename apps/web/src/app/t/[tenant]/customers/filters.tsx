"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { CHURN_RISKS, RFM_TIERS } from "@hullwise/core";
import { Button, FilterChip, FilterPanel, Input, Select, cn } from "@hullwise/ui";

export function CustomerFiltersBar({ basePath, filters, countries }: { basePath: string; filters: Record<string, string | undefined>; countries: string[] }) {
  const t = useTranslations("customers");
  const tr = useTranslations("rfm");
  const tp = useTranslations("predictions");
  const tm = useTranslations("mobile");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const apply = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch, page: undefined })) if (v) u.set(k, v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  // filters inside the phone sheet, shown as removable chips (#49)
  const chips: { key: string; label: string }[] = [
    ...(filters.country ? [{ key: "country", label: filters.country }] : []),
    ...(filters.tier ? [{ key: "tier", label: tr(`tier.${filters.tier}`) }] : []),
    ...(filters.churn ? [{ key: "churn", label: tp(`risk.${filters.churn}`) }] : []),
    ...(filters.marketing === "1" ? [{ key: "marketing", label: t("only_marketing") }] : []),
  ];
  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
        </div>
        <Button type="submit" variant="secondary" className="shrink-0 md:hidden">{t("search")}</Button>
      </form>
      <FilterPanel label={tm("filters.label")} title={tm("filters.title")} doneLabel={tm("filters.done")} closeLabel={tm("close")} activeCount={chips.length + (filters.sort && filters.sort !== "last_order" ? 1 : 0)} chips={chips.length > 0 ? chips.map((c) => <FilterChip key={c.key} className="md:hidden" removeLabel={tm("filters.remove")} onRemove={() => apply({ [c.key]: undefined })} data-testid={`chip-${c.key}`}>{c.label}</FilterChip>) : undefined}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Select aria-label={t("columns.country")} value={filters.country ?? ""} onChange={(e) => apply({ country: e.target.value || undefined })}>
            <option value="">{t("all_countries")}</option>
            {countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
          <Select aria-label={t("columns.tier")} value={filters.tier ?? ""} onChange={(e) => apply({ tier: e.target.value || undefined })}>
            <option value="">{t("all_tiers")}</option>
            {RFM_TIERS.map((x) => (
              <option key={x} value={x}>{tr(`tier.${x}`)}</option>
            ))}
          </Select>
          <Select aria-label={t("columns.churn")} value={filters.churn ?? ""} onChange={(e) => apply({ churn: e.target.value || undefined })}>
            <option value="">{t("all_churn")}</option>
            {CHURN_RISKS.map((x) => (
              <option key={x} value={x}>{tp(`risk.${x}`)}</option>
            ))}
          </Select>
          <Select aria-label={t("sort")} value={filters.sort ?? "last_order"} onChange={(e) => apply({ sort: e.target.value })}>
            {["last_order", "total_spent", "orders", "name", "predicted_value"].map((s) => (
              <option key={s} value={s}>{t(`sorts.${s}`)}</option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4" checked={filters.marketing === "1"} onChange={(e) => apply({ marketing: e.target.checked ? "1" : undefined })} />
            {t("only_marketing")}
          </label>
        </div>
      </FilterPanel>
    </div>
  );
}
