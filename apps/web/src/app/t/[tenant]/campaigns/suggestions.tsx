"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@keel/ui";
import { autoLink, linkProduct } from "@/server/actions/campaigns";
import type { ActionResult } from "@/server/action-result";

export interface SuggestionGroup {
  campaignId: string;
  name: string;
  platform: string;
  suggestions: { productId: string; title: string; kind: string; confidence: number }[];
}

export function SuggestionsPanel({ slug, groups, canEdit }: { slug: string; groups: SuggestionGroup[]; canEdit: boolean }) {
  const t = useTranslations("campaigns");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<{ linked: number }> | ActionResult | null>(null);
  if (!groups.length) return null;
  const exact = groups.filter((g) => (g.suggestions[0]?.confidence ?? 0) >= 0.95).length;
  return (
    <Card className="mt-4" data-testid="campaign-suggestions">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">{t("suggestions_title")}</CardTitle>
          <CardDescription>{t("suggestions_description")}</CardDescription>
        </div>
        {canEdit && exact > 0 && (
          <Button size="sm" disabled={pending} onClick={() => start(async () => setResult(await autoLink(slug)))}>
            {t("auto_link")} ({exact})
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {result && !result.ok && (
          <Alert variant="destructive">
            <AlertDescription>{tc(`errors.${result.error}`)}</AlertDescription>
          </Alert>
        )}
        {result && result.ok && "data" in result && result.data && "linked" in result.data && <p className="text-sm text-muted-foreground">{t("linked_n", { n: result.data.linked })}</p>}
        <ul className="divide-y text-sm">
          {groups.slice(0, 12).map((g) => (
            <li key={g.campaignId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 truncate">
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs uppercase">{g.platform}</span>
                {g.name}
              </span>
              <span className="flex flex-wrap gap-1">
                {g.suggestions.map((s) => (
                  <Button key={s.productId} size="sm" variant="outline" disabled={!canEdit || pending} title={`${s.kind} · ${Math.round(s.confidence * 100)}%`} onClick={() => start(async () => setResult(await linkProduct(slug, g.campaignId, s.productId, true, "suggested")))}>
                    {t("link")}: {s.title}
                  </Button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
