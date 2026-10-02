"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Input, cn } from "@hullwise/ui";

const STATES = ["all", "active", "scheduled", "expired", "exhausted", "disabled"] as const;

export function DiscountFiltersBar({ basePath, filters, counts }: { basePath: string; filters: { q?: string; state?: string; pool?: string }; counts: Record<string, number> }) {
  const t = useTranslations("discounts");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const apply = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) u.set(k, v);
    start(() => router.push(`${basePath}${u.size ? `?${u}` : ""}`));
  };
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      {/* state views: one scrolling row on phones (#49) */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0" data-testid="state-chips">
        {STATES.map((s) => (
          <button key={s} type="button" onClick={() => apply({ state: s === "all" ? undefined : s })} aria-pressed={(filters.state ?? "all") === s} data-testid={`state-${s}`} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9", (filters.state ?? "all") === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {t(`state.${s}`)} <span className="tabular font-normal">{s === "all" ? total : counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <form className="relative max-w-md" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
      </form>
    </div>
  );
}
