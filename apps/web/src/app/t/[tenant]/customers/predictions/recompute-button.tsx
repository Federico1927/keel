"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Button } from "@hullwise/ui";
import { recomputePredictionsAction } from "@/server/actions/predictions";

export function RecomputeButton({ slug }: { slug: string }) {
  const t = useTranslations("predictions");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{tc(`errors.${error}`)}</span>}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await recomputePredictionsAction(slug); if (!r.ok) setError(r.error); else { setError(null); router.refresh(); } })}>
        <RefreshCw className={pending ? "animate-spin" : undefined} /> {pending ? t("recomputing") : t("recompute")}
      </Button>
    </span>
  );
}
