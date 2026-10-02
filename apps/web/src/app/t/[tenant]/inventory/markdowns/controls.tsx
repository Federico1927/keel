"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Checkbox } from "@keel/ui";
import type { BatchSummary } from "@keel/services";
import { applyMarkdownsAction } from "@/server/actions/inventory-control";

export interface MarkdownView {
  variantId: string;
  productId: string;
  label: string;
  detail: string;
  reason: "no_sales" | "slow" | "excess";
  available: number;
  cover: number | null;
  price: string;
  newPrice: string;
  compareAt: string;
  discount: string;
  floor: string;
  margin: string;
  clamped: boolean;
}

/** Suggestions with selection; "apply" writes the markdowns in one batch (recomputed on the server). */
export function MarkdownTable({ slug, rows, canApply }: { slug: string; rows: MarkdownView[]; canApply: boolean }) {
  const t = useTranslations("inventory_control.markdowns");
  const te = useTranslations("inventory_control.errors");
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const all = selected.size === rows.length && rows.length > 0;
  return (
    <div className="space-y-3">
      {canApply && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || selected.size === 0}
            data-testid="apply-markdowns"
            onClick={() => {
              if (!window.confirm(t("apply_confirm", { n: selected.size }))) return;
              start(async () => {
                const r = await applyMarkdownsAction(slug, [...selected]);
                if (!r.ok) return setError(te(r.error));
                setError(null);
                setSummary(r.data ?? null);
                setSelected(new Set());
                router.refresh();
              });
            }}
          >
            {t("apply", { n: selected.size })}
          </Button>
          {summary && (
            <span className="text-sm" data-testid="markdown-summary" role="status">
              {t("summary", { done: summary.done, skipped: summary.skipped, failed: summary.failed })}
            </span>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              {canApply && <th className="w-8 p-2"><Checkbox checked={all} onCheckedChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.variantId)))} aria-label={t("select_all")} data-testid="markdown-select-all" /></th>}
              <th className="p-2 text-left font-medium">{t("columns.variant")}</th>
              <th className="hidden p-2 text-left font-medium md:table-cell">{t("columns.reason")}</th>
              <th className="p-2 text-right font-medium">{t("columns.stock")}</th>
              <th className="hidden p-2 text-right font-medium lg:table-cell">{t("columns.cover")}</th>
              <th className="p-2 text-right font-medium">{t("columns.price")}</th>
              <th className="p-2 text-right font-medium">{t("columns.new_price")}</th>
              <th className="hidden p-2 text-right font-medium md:table-cell">{t("columns.floor")}</th>
              <th className="hidden p-2 text-right font-medium md:table-cell">{t("columns.margin")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.variantId} className="border-b last:border-0" data-testid="markdown-row">
                {canApply && <td className="p-2"><Checkbox checked={selected.has(r.variantId)} onCheckedChange={() => toggle(r.variantId)} aria-label={r.label} data-testid="markdown-select" /></td>}
                <td className="p-2">
                  <Link href={`/t/${slug}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.label}</Link>
                  <p className="text-xs text-muted-foreground">{r.detail}</p>
                </td>
                <td className="hidden p-2 md:table-cell"><Badge variant={r.reason === "excess" ? "warning" : "destructive"}>{t(`reasons.${r.reason}`)}</Badge></td>
                <td className="p-2 text-right tabular">{r.available}</td>
                <td className="hidden p-2 text-right tabular lg:table-cell">{r.cover === null ? "—" : `${r.cover}d`}</td>
                <td className="p-2 text-right tabular text-muted-foreground">{r.price}</td>
                <td className="p-2 text-right tabular">
                  <span className="font-medium">{r.newPrice}</span> <span className="text-xs text-muted-foreground">(−{r.discount})</span>
                  <p className="text-xs text-muted-foreground line-through">{r.compareAt}</p>
                </td>
                <td className="hidden p-2 text-right tabular md:table-cell">{r.floor}{r.clamped && <Badge variant="info" className="ml-1">{t("at_floor")}</Badge>}</td>
                <td className="hidden p-2 text-right tabular md:table-cell">{r.margin}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
