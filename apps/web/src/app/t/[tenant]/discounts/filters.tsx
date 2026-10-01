"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Input, cn } from "@keel/ui";

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
      <div className="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <button key={s} type="button" onClick={() => apply({ state: s === "all" ? undefined : s })} className={cn("rounded-full border px-3 py-1 text-xs", (filters.state ?? "all") === s ? "bg-primary text-primary-foreground" : "bg-card")}>
            {t(`state.${s}`)} <span className="tabular opacity-70">{s === "all" ? total : counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <form className="relative max-w-md" onSubmit={(e) => { e.preventDefault(); apply({ q }); }}>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} className="pl-8" aria-label={t("search")} />
      </form>
    </div>
  );
}
