"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { formatMoney } from "@hullwise/core";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, Input, Label, Select, Stat, Switch } from "@hullwise/ui";
import { confirmCostImportAction, previewCostImportAction, saveCostWriteBackAction, type CostImportPreviewView } from "@/server/actions/catalog";

const STATUSES = ["matched", "unchanged", "unmatched", "ambiguous", "invalid"] as const;
const BADGE: Record<(typeof STATUSES)[number], "success" | "muted" | "warning" | "destructive"> = { matched: "success", unchanged: "muted", unmatched: "warning", ambiguous: "warning", invalid: "destructive" };

/** Two steps: the file is parsed and matched on the server (nothing written), then confirmed. */
export function CostImportForm({ slug, currency, locale }: { slug: string; currency: string; locale: string }) {
  const t = useTranslations("cost_import");
  const tc = useTranslations("common");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [applyTo, setApplyTo] = useState<"missing" | "all">("missing");
  const [preview, setPreview] = useState<CostImportPreviewView | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const money = (m: number | null) => (m === null ? "—" : formatMoney(m, currency, locale));
  const onFile = async (f: File | undefined) => {
    setPreview(null);
    setMessage(null);
    setFile(f ? { name: f.name, text: await f.text() } : null);
  };
  const runPreview = () =>
    start(async () => {
      if (!file) return;
      const r = await previewCostImportAction(slug, { csv: file.text, fileName: file.name, applyTo });
      if (!r.ok) return setMessage({ ok: false, text: tc(`errors.${r.error}`) });
      setPreview(r.data ?? null);
    });
  const confirm = () =>
    start(async () => {
      if (!file) return;
      const r = await confirmCostImportAction(slug, { csv: file.text, fileName: file.name, applyTo });
      if (!r.ok) return setMessage({ ok: false, text: tc(`errors.${r.error}`) });
      setMessage({ ok: true, text: t("done", { written: r.data?.written ?? 0, lines: r.data?.lines ?? 0 }) });
      setPreview(null);
      setFile(null);
    });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("file_title")}</CardTitle>
          <CardDescription>{t("file_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cost-file">{t("file")}</Label>
              <Input id="cost-file" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="cost-file" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-apply">{t("apply_to")}</Label>
              <Select id="cost-apply" value={applyTo} onChange={(e) => setApplyTo(e.target.value as "missing" | "all")}>
                <option value="missing">{t("apply_missing")}</option>
                <option value="all">{t("apply_all")}</option>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" disabled={!file || pending} onClick={runPreview} data-testid="cost-preview">{t("preview")}</Button>
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent("sku,cost,supplier_sku\n")}`} download="costs-template.csv" className="text-sm text-primary underline-offset-4 hover:underline">{t("template")}</a>
          </div>
        </CardContent>
      </Card>
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"}>
          <AlertDescription data-testid="cost-import-message">{message.text}</AlertDescription>
        </Alert>
      )}
      {preview?.fileError && (
        <Alert variant="destructive">
          <AlertDescription data-testid="cost-file-error">{t(`file_error.${preview.fileError}`)}</AlertDescription>
        </Alert>
      )}
      {preview?.counts && (
        <Card data-testid="cost-preview-result">
          <CardHeader>
            <CardTitle className="text-base">{t("preview_title")}</CardTitle>
            <CardDescription>{t("preview_hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {STATUSES.map((s) => (
                <Stat key={s} label={t(`status.${s}`)} value={preview.counts![s]} />
              ))}
            </div>
            <div className="-mx-(--density-card) border-y">
              <DataList
                rows={preview.rows}
                rowKey={(r) => String(r.line)}
                rowProps={(r) => ({ "data-testid": `preview-${r.status}` })}
                columns={[
                  { key: "line", header: t("columns.line"), className: "tabular text-muted-foreground", cell: (r) => r.line },
                  { key: "sku", header: t("columns.sku"), mobile: "title", className: "text-xs", cell: (r) => r.sku ?? r.supplierSku ?? "—" },
                  { key: "status", header: t("columns.status"), mobile: "badge", cell: (r) => <Badge variant={BADGE[r.status]}>{t(`status.${r.status}`)}</Badge> },
                  { key: "variant", header: t("columns.variant"), mobile: "subtitle", className: "text-xs", cell: (r) => r.label ?? (r.error ? t(`row_error.${r.error}`) : "—") },
                  { key: "cost", header: t("columns.cost"), align: "right", className: "tabular text-xs", cell: (r) => (r.status === "matched" ? `${money(r.fromMinor)} → ${money(r.costMinor)}` : r.costMinor !== null ? money(r.costMinor) : r.rawCost || "—") },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={pending || preview.counts.matched === 0} onClick={confirm} data-testid="cost-confirm">{t("confirm", { n: preview.counts.matched })}</Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setPreview(null)}>{tc("cancel")}</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function CostWriteBackToggle({ slug, enabled, canEdit }: { slug: string; enabled: boolean; canEdit: boolean }) {
  const t = useTranslations("cost_import");
  const [value, setValue] = useState(enabled);
  const [pending, start] = useTransition();
  return (
    <label className="flex items-start gap-3 text-sm">
      <Switch checked={value} disabled={!canEdit || pending} onCheckedChange={(v) => start(async () => { const r = await saveCostWriteBackAction(slug, v); if (r.ok) setValue(v); })} data-testid="cost-write-back" />
      <span>
        <span className="font-medium">{t("write_back")}</span>
        <span className="block text-xs text-muted-foreground">{t("write_back_hint")}</span>
      </span>
    </label>
  );
}
