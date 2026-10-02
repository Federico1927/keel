"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Input, cn } from "@hullwise/ui";

/** Preset + custom range picker; `keep` are the other search params to preserve. */
export function PeriodPicker({ basePath, keep = {}, preset, from, to }: { basePath: string; keep?: Record<string, string | undefined>; preset?: string; from?: string; to?: string }) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const [f, setF] = useState(from ?? "");
  const [tt, setTt] = useState(to ?? "");
  const go = (p: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...p })) if (v) u.set(k, v);
    router.push(`${basePath}?${u}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {["7d", "30d", "90d", "mtd", "ytd"].map((p) => (
        <button key={p} type="button" onClick={() => go({ preset: p })} className={cn("rounded-full border px-3 py-1 text-xs", preset === p ? "bg-primary text-primary-foreground" : "bg-card")}>
          {t(`presets.${p}`)}
        </button>
      ))}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          go({ from: f, to: tt });
        }}
      >
        <Input size="sm" type="date" value={f} onChange={(e) => setF(e.target.value)} className="w-36" aria-label={t("from")} />
        <Input size="sm" type="date" value={tt} onChange={(e) => setTt(e.target.value)} className="w-36" aria-label={t("to")} />
        <Button type="submit" size="sm" variant="secondary">{t("apply")}</Button>
      </form>
    </div>
  );
}
