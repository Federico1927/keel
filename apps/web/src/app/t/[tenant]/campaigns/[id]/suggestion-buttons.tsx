"use client";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@keel/ui";
import { linkProduct } from "@/server/actions/campaigns";

export function SuggestionLinkButtons({ slug, campaignId, suggestions }: { slug: string; campaignId: string; suggestions: { productId: string; title: string; kind: string; confidence: number }[] }) {
  const t = useTranslations("campaigns");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap gap-1">
      {suggestions.map((s) => (
        <Button key={s.productId} size="sm" variant="outline" disabled={pending} title={`${s.kind} · ${Math.round(s.confidence * 100)}%`} onClick={() => start(async () => void (await linkProduct(slug, campaignId, s.productId, true, "suggested")))}>
          {t("link")}: {s.title}
        </Button>
      ))}
    </div>
  );
}
