"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button, FilterChip, FilterPanel, Input, Label, Select, cn } from "@hullwise/ui";

type Filters = { status?: string; supplier?: string; destination?: string; q?: string; from?: string; to?: string };

/** Purchase order filters (#49): search inline, the rest in the phone sheet with removable chips. */
export function PoFiltersBar({ basePath, filters, suppliers, locations }: { basePath: string; filters: Filters; suppliers: { id: string; name: string }[]; locations: { id: string; name: string }[] }) {
  const t = useTranslations("purchasing");
  const tm = useTranslations("mobile");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const apply = (patch: Partial<Filters>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) u.set(k, v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  const chips: { key: keyof Filters; label: string }[] = [
    ...(filters.supplier ? [{ key: "supplier" as const, label: suppliers.find((s) => s.id === filters.supplier)?.name ?? t("columns.supplier") }] : []),
    ...(filters.destination ? [{ key: "destination" as const, label: locations.find((l) => l.id === filters.destination)?.name ?? t("filters.destination") }] : []),
    ...(filters.from ? [{ key: "from" as const, label: `${t("filters.from")} ${filters.from}` }] : []),
    ...(filters.to ? [{ key: "to" as const, label: `${t("filters.to")} ${filters.to}` }] : []),
  ];
  const filtered = Boolean(filters.q || chips.length);
  return (
    <form className={cn("mb-4 space-y-3 rounded-lg border bg-card p-3", pending && "opacity-70")} data-testid="po-filters" onSubmit={(e) => { e.preventDefault(); apply({ q: q.trim() || undefined }); }}>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="po-q" className="text-xs">{t("filters.search")}</Label>
          <Input id="po-q" name="q" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("filters.search_placeholder")} />
        </div>
        <Button type="submit" size="sm" className="shrink-0">{t("filters.apply")}</Button>
      </div>
      <FilterPanel label={tm("filters.label")} title={tm("filters.title")} doneLabel={tm("filters.done")} closeLabel={tm("close")} activeCount={chips.length} chips={chips.length > 0 ? chips.map((c) => <FilterChip key={c.key} className="md:hidden" removeLabel={tm("filters.remove")} onRemove={() => apply({ [c.key]: undefined })} data-testid={`chip-${c.key}`}>{c.label}</FilterChip>) : undefined}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1">
            <Label htmlFor="po-supplier-f" className="text-xs">{t("columns.supplier")}</Label>
            <Select id="po-supplier-f" value={filters.supplier ?? ""} onChange={(e) => apply({ supplier: e.target.value || undefined })}>
              <option value="">{t("filters.all_suppliers")}</option>
              {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="po-destination-f" className="text-xs">{t("filters.destination")}</Label>
            <Select id="po-destination-f" value={filters.destination ?? ""} onChange={(e) => apply({ destination: e.target.value || undefined })}>
              <option value="">{t("filters.all_destinations")}</option>
              {locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="po-from" className="text-xs">{t("filters.from")}</Label>
            <Input id="po-from" type="date" className="min-w-0" defaultValue={filters.from ?? ""} onChange={(e) => apply({ from: e.target.value || undefined })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="po-to" className="text-xs">{t("filters.to")}</Label>
            <Input id="po-to" type="date" className="min-w-0" defaultValue={filters.to ?? ""} onChange={(e) => apply({ to: e.target.value || undefined })} />
          </div>
          {filtered && (
            <div className="flex items-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setQ(""); apply({ q: undefined, supplier: undefined, destination: undefined, from: undefined, to: undefined }); }}>{t("filters.clear")}</Button>
            </div>
          )}
        </div>
      </FilterPanel>
    </form>
  );
}
