"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { optionStockGrid, type GridCell, type GridVariant } from "@keel/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Select, cn } from "@keel/ui";

/** Option × option stock grid: available, +incoming, −committed per cell, for whatever options the product has. */
export function StockGrid({ options, variants, locale }: { options: { name: string; values: string[] }[]; variants: GridVariant[]; locale: string }) {
  const t = useTranslations("product_detail.grid");
  const names = useMemo(() => [...new Set([...options.map((o) => o.name), ...variants.flatMap((v) => Object.keys(v.optionValues))])], [options, variants]);
  const [rows, setRows] = useState(names[0] ?? "");
  const [cols, setCols] = useState(names[1] ?? "");
  const grid = useMemo(() => optionStockGrid(options, variants, { rows, cols }), [options, variants, rows, cols]);
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const value = (v: string) => v || t("none");
  const Cell = ({ c, total = false, testId }: { c: GridCell; total?: boolean; testId?: string }) => (
    <td className={cn("border px-2 py-1.5 text-right align-top tabular", total && "bg-muted/40 font-medium", !c.variantIds.length && !total && "bg-muted/20 text-muted-foreground")} data-testid={testId}>
      {c.variantIds.length || total ? (
        <>
          <span className={cn("block text-sm", c.available <= 0 && "text-destructive")} data-available={c.available}>{n(c.available)}</span>
          {(c.incoming > 0 || c.committed > 0) && (
            <span className="block text-[11px] leading-tight text-muted-foreground">
              {c.incoming > 0 && <span className="text-success">+{n(c.incoming)}</span>}
              {c.incoming > 0 && c.committed > 0 && " "}
              {c.committed > 0 && <span>−{n(c.committed)}</span>}
            </span>
          )}
        </>
      ) : (
        "·"
      )}
    </td>
  );
  return (
    <Card data-testid="stock-grid">
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("legend")}</CardDescription>
        </div>
        {names.length > 1 && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="grid-rows" className="text-xs">{t("rows")}</Label>
              <Select id="grid-rows" value={grid.rowOption ?? ""} onChange={(e) => { setRows(e.target.value); if (e.target.value === cols) setCols(grid.rowOption ?? ""); }} className="h-8 text-xs">
                {names.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="grid-cols" className="text-xs">{t("cols")}</Label>
              <Select id="grid-cols" value={grid.colOption ?? ""} onChange={(e) => { setCols(e.target.value); if (e.target.value === rows) setRows(grid.colOption ?? ""); }} className="h-8 text-xs">
                {names.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border bg-muted/40 px-2 py-1.5 text-left font-medium">{grid.rowOption && grid.colOption ? `${grid.rowOption} × ${grid.colOption}` : (grid.rowOption ?? "")}</th>
                {grid.colOption && grid.cols.map((c) => <th key={c} className="border bg-muted/40 px-2 py-1.5 text-right font-medium">{value(c)}</th>)}
                <th className="border bg-muted/40 px-2 py-1.5 text-right font-medium">{t("total")}</th>
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((r, ri) => (
                <tr key={r}>
                  <th scope="row" className="border px-2 py-1.5 text-left font-medium">{grid.rowOption ? value(r) : t("all")}</th>
                  {grid.colOption && grid.cols.map((c, ci) => <Cell key={c} c={grid.cells[ri]![ci]!} />)}
                  <Cell c={grid.rowTotals[ri]!} total />
                </tr>
              ))}
              <tr>
                <th scope="row" className="border bg-muted/40 px-2 py-1.5 text-left font-medium">{t("total")}</th>
                {grid.colOption && grid.colTotals.map((c, ci) => <Cell key={grid.cols[ci]} c={c} total />)}
                <Cell c={grid.total} total testId="stock-grid-total" />
              </tr>
            </tbody>
          </table>
        </div>
        {grid.folded.length > 0 && <p className="text-xs text-muted-foreground">{t("folded", { options: grid.folded.join(", ") })}</p>}
      </CardContent>
    </Card>
  );
}
