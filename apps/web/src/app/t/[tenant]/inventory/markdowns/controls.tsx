"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Checkbox, DataList } from "@hullwise/ui";
import type { BatchSummary } from "@hullwise/services";
import { applyMarkdownsAction } from "@/server/actions/inventory-control";
import { ConfirmDialog } from "@/components/confirm-button";

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
  const [confirming, setConfirming] = useState(false);
  const apply = () =>
    start(async () => {
      const r = await applyMarkdownsAction(slug, [...selected]);
      if (!r.ok) return setError(te(r.error));
      setError(null);
      setSummary(r.data ?? null);
      setSelected(new Set());
      router.refresh();
    });
  return (
    <div className="space-y-3">
      {canApply && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending || selected.size === 0} data-testid="apply-markdowns" onClick={() => setConfirming(true)}>
            {t("apply", { n: selected.size })}
          </Button>
          <label className="flex items-center gap-2 text-sm md:hidden">
            <Checkbox checked={all} onCheckedChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.variantId)))} aria-label={t("select_all")} />
            {t("select_all")}
          </label>
          {summary && (
            <span className="text-sm" data-testid="markdown-summary" role="status">
              {t("summary", { done: summary.done, skipped: summary.skipped, failed: summary.failed })}
            </span>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={t("apply_confirm", { n: selected.size })} confirmLabel={t("apply", { n: selected.size })} onConfirm={apply} pending={pending} />
        </div>
      )}
      <div className="rounded-lg border bg-card">
        <DataList
          rows={rows}
          rowKey={(r) => r.variantId}
          rowProps={() => ({ "data-testid": "markdown-row" })}
          columns={[
            ...(canApply ? [{ key: "select", header: <Checkbox checked={all} onCheckedChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.variantId)))} aria-label={t("select_all")} data-testid="markdown-select-all" />, mobile: "select" as const, headClassName: "w-8", cell: (r: MarkdownView) => <Checkbox checked={selected.has(r.variantId)} onCheckedChange={() => toggle(r.variantId)} aria-label={r.label} data-testid="markdown-select" /> }] : []),
            { key: "variant", header: t("columns.variant"), mobile: "title", cell: (r) => <><Link href={`/t/${slug}/products/${r.productId}`} className="font-medium text-primary hover:underline">{r.label}</Link><p className="text-xs font-normal text-muted-foreground">{r.detail}</p></> },
            { key: "reason", header: t("columns.reason"), mobile: "badge", cell: (r) => <Badge variant={r.reason === "excess" ? "warning" : "destructive"}>{t(`reasons.${r.reason}`)}</Badge> },
            { key: "stock", header: t("columns.stock"), align: "right", className: "tabular", cell: (r) => r.available },
            { key: "cover", header: t("columns.cover"), align: "right", priority: 2, className: "tabular", cell: (r) => (r.cover === null ? "—" : `${r.cover}d`) },
            { key: "price", header: t("columns.price"), align: "right", className: "tabular text-muted-foreground max-md:hidden", cell: (r) => r.price },
            { key: "new_price", header: t("columns.new_price"), mobile: "subtitle", align: "right", className: "tabular", cell: (r) => <><span className="text-xs text-muted-foreground line-through md:hidden">{r.price}</span> <span className="font-medium max-md:text-foreground">{r.newPrice}</span> <span className="text-xs text-muted-foreground">(−{r.discount})</span><p className="text-xs text-muted-foreground line-through max-md:hidden">{r.compareAt}</p></> },
            { key: "floor", header: t("columns.floor"), align: "right", className: "tabular", cell: (r) => <>{r.floor}{r.clamped && <Badge variant="info" className="ml-1">{t("at_floor")}</Badge>}</> },
            { key: "margin", header: t("columns.margin"), align: "right", className: "tabular", cell: (r) => r.margin },
          ]}
        />
      </div>
    </div>
  );
}
