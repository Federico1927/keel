"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { saveVariantCosts } from "@/server/actions/catalog";

export interface CostVariant {
  id: string;
  title: string;
  sku: string | null;
  cost: string;
  source: string | null;
  updated: string | null;
}

/** Cost per variant, a "same cost for all" helper, and which past orders take the new cost. */
export function VariantCostsForm({ slug, productId, variants, canEdit, writeBack }: { slug: string; productId: string; variants: CostVariant[]; canEdit: boolean; writeBack: boolean }) {
  const t = useTranslations("product_costs");
  const tc = useTranslations("common");
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(variants.map((v) => [v.id, v.cost])));
  const [bulk, setBulk] = useState("");
  const [applyTo, setApplyTo] = useState<"missing" | "all">("missing");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: true; changed: number; lines: number } | { ok: false; error: string } | null>(null);
  const dirty = variants.some((v) => (values[v.id] ?? "") !== v.cost);
  const save = () =>
    start(async () => {
      const r = await saveVariantCosts(slug, { productId, applyTo, costs: variants.filter((v) => (values[v.id] ?? "") !== v.cost).map((v) => ({ variantId: v.id, cost: values[v.id] ?? "" })) });
      setResult(r.ok ? { ok: true, changed: r.data?.changed ?? 0, lines: r.data?.lines ?? 0 } : { ok: false, error: r.error });
    });
  return (
    <Card data-testid="variant-costs">
      <CardHeader>
        <CardTitle className="text-base">{t("card_title")}</CardTitle>
        <CardDescription>{t("card_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit && variants.length > 1 && (
          <div className="flex flex-wrap items-end gap-2">
            <Input type="text" inputMode="decimal" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="0.00" className="h-9 w-32 text-right" aria-label={t("bulk_label")} data-testid="cost-bulk" />
            <Button type="button" variant="outline" size="sm" disabled={!bulk.trim()} onClick={() => setValues(Object.fromEntries(variants.map((v) => [v.id, bulk.trim()])))}>
              {t("bulk_apply")}
            </Button>
          </div>
        )}
        <div className="-mx-6 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("variant")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("sku")}</TableHead>
                <TableHead className="text-right">{t("cost")}</TableHead>
                <TableHead>{t("source_label")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => (
                <TableRow key={v.id} data-testid="cost-row">
                  <TableCell className="font-medium">{v.title}</TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{v.sku ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {canEdit ? <Input type="text" inputMode="decimal" value={values[v.id] ?? ""} onChange={(e) => setValues((x) => ({ ...x, [v.id]: e.target.value }))} placeholder="—" className="ml-auto h-8 w-24 text-right" aria-label={t("cost_of", { variant: v.title })} data-testid="cost-input" /> : <span className="tabular">{v.cost || "—"}</span>}
                  </TableCell>
                  <TableCell>
                    {v.cost ? <Badge variant={v.source === "po_receipt" ? "success" : v.source ? "secondary" : "outline"}>{t(`source.${v.source ?? "unknown"}`)}</Badge> : <Badge variant="warning">{t("missing")}</Badge>}
                    {v.updated && <span className="ml-2 hidden text-xs text-muted-foreground md:inline">{v.updated}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={applyTo} onChange={(e) => setApplyTo(e.target.value as "missing" | "all")} className="w-auto" aria-label={t("apply_to")} data-testid="cost-apply-to">
              <option value="missing">{t("apply_missing")}</option>
              <option value="all">{t("apply_all")}</option>
            </Select>
            <Button type="button" size="sm" disabled={!dirty || pending} onClick={save} data-testid="cost-save">
              {tc("save")}
            </Button>
            {writeBack && <span className="text-xs text-muted-foreground">{t("write_back_on")}</span>}
          </div>
        )}
        {result && (
          <Alert variant={result.ok ? "default" : "destructive"}>
            <AlertDescription data-testid="cost-result">{result.ok ? t("saved", { changed: result.changed, lines: result.lines }) : tc(`errors.${result.error}`)}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
