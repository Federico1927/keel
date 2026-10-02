"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { compileFormula } from "@hullwise/core";
import { SUPPORTED_LOCALES, type MetricFilters } from "@hullwise/config";
import { Button, Input, Label, Select, Textarea, cn } from "@hullwise/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { deleteTenantMetricAction, previewMetricAction, saveTenantMetricAction, setMetricTargetAction } from "@/server/actions/dashboards";

export interface BaseOption {
  ref: string;
  label: string;
  filterable: boolean;
}

export interface FilterOptions {
  channels: string[];
  countries: string[];
  paymentMethods: string[];
  campaigns: { id: string; name: string; platform: string }[];
  platforms: string[];
  products: { id: string; title: string }[];
  productTypes: string[];
}

export interface MetricDraft {
  key: string;
  label: string;
  formula: string;
  format: "money" | "ratio" | "percent" | "number";
  filters: MetricFilters;
  higherIsBetter: boolean;
  translations: Record<string, string>;
  description: string | null;
}

const EMPTY: MetricDraft = { key: "", label: "", formula: "", format: "money", filters: {}, higherIsBetter: true, translations: {}, description: null };

function MultiSelect({ id, label, options, value, onChange }: { id: string; label: string; options: { value: string; label: string }[]; value: string[] | undefined; onChange: (v: string[]) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} multiple value={value ?? []} onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))} className="min-h-20">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </div>
  );
}

/**
 * Custom metric builder: a formula over the base metrics with autocomplete and live validation,
 * filters on the orders it is computed over, format, trend direction, translations, and a preview
 * on the current month. Saving is audited by the server.
 */
export function MetricBuilder({ slug, bases, options, initial }: { slug: string; bases: BaseOption[]; options: FilterOptions; initial?: MetricDraft | null }) {
  const t = useTranslations("dashboards.builder");
  const te = useTranslations("dashboards.errors");
  const td = useTranslations("dashboards");
  const router = useRouter();
  const [m, setM] = useState<MetricDraft>(initial ?? EMPTY);
  const [preview, setPreview] = useState<{ value: string; previous: string } | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const filtered = Object.values(m.filters).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
  const allowed = useMemo(() => bases.filter((b) => !filtered || b.filterable), [bases, filtered]);
  const check = m.formula.trim() ? compileFormula(m.formula, allowed.map((b) => b.ref)) : null;
  const fragment = /([a-z_][a-z0-9_]*)$/i.exec(m.formula)?.[1]?.toLowerCase() ?? "";
  const suggestions = fragment ? allowed.filter((b) => b.ref.startsWith(fragment) && b.ref !== fragment).slice(0, 8) : [];
  const setFilter = <K extends keyof MetricFilters>(k: K, v: MetricFilters[K]) => setM((x) => ({ ...x, filters: { ...x.filters, [k]: v } }));
  const payload = () => ({ ...m, key: m.key || m.label, filters: m.filters as Record<string, unknown> });
  const errorText = (code: string, detail?: string) => (te.has(code) ? te(code) : te("generic")) + (code === "invalid_formula" && detail ? ` (${detail})` : "");

  return (
    <form
      className="space-y-4"
      data-testid="metric-builder"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setMessage(null);
          const r = await saveTenantMetricAction(slug, payload());
          if (!r.ok) return setMessage({ kind: "error", text: errorText(r.error, r.fieldErrors?.detail) });
          setMessage({ kind: "ok", text: t("saved") });
          if (!initial) setM(EMPTY);
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="m-label">{t("label")}</Label><Input id="m-label" value={m.label} maxLength={80} required onChange={(e) => setM({ ...m, label: e.target.value })} placeholder={t("label_placeholder")} /></div>
        <div className="space-y-1"><Label htmlFor="m-key">{t("key")}</Label><Input id="m-key" value={m.key} maxLength={40} disabled={Boolean(initial)} onChange={(e) => setM({ ...m, key: e.target.value })} placeholder={t("key_placeholder")} /></div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="m-formula">{t("formula")}</Label>
        <Input id="m-formula" value={m.formula} required maxLength={300} autoComplete="off" spellCheck={false} className="font-mono" onChange={(e) => setM({ ...m, formula: e.target.value })} placeholder="contribution / orders" aria-describedby="m-formula-help" />
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="formula-suggestions">
            {suggestions.map((s) => (
              <button key={s.ref} type="button" className="rounded border px-1.5 py-0.5 font-mono text-xs hover:bg-muted" onClick={() => setM({ ...m, formula: m.formula.slice(0, m.formula.length - fragment.length) + s.ref + " " })} title={s.label}>{s.ref}</button>
            ))}
          </div>
        )}
        <p id="m-formula-help" className={cn("text-xs", check && !check.ok ? "text-destructive" : "text-muted-foreground")} data-testid="formula-status">
          {check ? (check.ok ? t("formula_ok") : filtered && compileFormula(m.formula, bases.map((b) => b.ref)).ok ? te("not_filterable") : `${t("formula_error")}: ${check.error}`) : t("formula_help")}
        </p>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("available")}</summary><p className="mt-1 font-mono leading-relaxed">{allowed.map((b) => b.ref).join(" · ")}</p></details>
      </div>
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("filters")}</legend>
        <p className="text-xs text-muted-foreground">{t("filters_hint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <MultiSelect id="f-channel" label={t("f_channel")} options={options.channels.map((c) => ({ value: c, label: td.has(`channels.${c}`) ? td(`channels.${c}`) : c }))} value={m.filters.channel} onChange={(v) => setFilter("channel", v)} />
          <MultiSelect id="f-country" label={t("f_country")} options={options.countries.map((c) => ({ value: c, label: c }))} value={m.filters.country} onChange={(v) => setFilter("country", v)} />
          <MultiSelect id="f-payment" label={t("f_payment")} options={options.paymentMethods.map((c) => ({ value: c, label: td.has(`payment_methods.${c}`) ? td(`payment_methods.${c}`) : c }))} value={m.filters.paymentMethod} onChange={(v) => setFilter("paymentMethod", v)} />
          <MultiSelect id="f-platform" label={t("f_platform")} options={options.platforms.map((c) => ({ value: c, label: c }))} value={m.filters.platform} onChange={(v) => setFilter("platform", v)} />
          <MultiSelect id="f-campaign" label={t("f_campaign")} options={options.campaigns.map((c) => ({ value: c.id, label: `${c.platform} · ${c.name}` }))} value={m.filters.campaignIds} onChange={(v) => setFilter("campaignIds", v)} />
          <MultiSelect id="f-product" label={t("f_product")} options={options.products.map((p) => ({ value: p.id, label: p.title }))} value={m.filters.productIds} onChange={(v) => setFilter("productIds", v)} />
          <MultiSelect id="f-type" label={t("f_product_type")} options={options.productTypes.map((c) => ({ value: c, label: c }))} value={m.filters.productType} onChange={(v) => setFilter("productType", v)} />
          <div className="space-y-1"><Label htmlFor="f-customer">{t("f_customer")}</Label><Select id="f-customer" value={m.filters.customerType ?? ""} onChange={(e) => setFilter("customerType", (e.target.value || undefined) as MetricFilters["customerType"])}><option value="">{t("f_customer_all")}</option><option value="new">{t("f_customer_new")}</option><option value="returning">{t("f_customer_returning")}</option></Select></div>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="m-format">{t("format")}</Label><Select id="m-format" value={m.format} onChange={(e) => setM({ ...m, format: e.target.value as MetricDraft["format"] })}>{(["money", "percent", "ratio", "number"] as const).map((f) => <option key={f} value={f}>{t(`formats.${f}`)}</option>)}</Select></div>
        <div className="space-y-1"><Label htmlFor="m-direction">{t("direction")}</Label><Select id="m-direction" value={m.higherIsBetter ? "up" : "down"} onChange={(e) => setM({ ...m, higherIsBetter: e.target.value === "up" })}><option value="up">{t("higher_better")}</option><option value="down">{t("lower_better")}</option></Select></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {SUPPORTED_LOCALES.map((l) => <div key={l} className="space-y-1"><Label htmlFor={`m-tr-${l}`}>{t("translation", { locale: l.toUpperCase() })}</Label><Input id={`m-tr-${l}`} value={m.translations[l] ?? ""} maxLength={80} onChange={(e) => setM({ ...m, translations: { ...m.translations, [l]: e.target.value } })} /></div>)}
      </div>
      <div className="space-y-1"><Label htmlFor="m-desc">{t("description_field")}</Label><Textarea id="m-desc" rows={2} maxLength={300} value={m.description ?? ""} onChange={(e) => setM({ ...m, description: e.target.value || null })} /></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending || !check?.ok} data-testid="metric-preview" onClick={() => start(async () => { setMessage(null); const r = await previewMetricAction(slug, payload()); if (r.ok && r.data) setPreview(r.data); else if (!r.ok) setMessage({ kind: "error", text: errorText(r.error, r.fieldErrors?.detail) }); })}>{t("preview")}</Button>
        <Button type="submit" size="sm" disabled={pending || !check?.ok} data-testid="metric-save">{t("save")}</Button>
        {initial && <Button type="button" size="sm" variant="ghost" onClick={() => router.push(`/t/${slug}/dashboards/metrics`)}>{t("cancel")}</Button>}
        {preview && <span className="text-sm" data-testid="metric-preview-value">{t("preview_value", { value: preview.value, previous: preview.previous })}</span>}
        {message && <span className={cn("text-xs", message.kind === "error" ? "text-destructive" : "text-success")} role="status">{message.text}</span>}
      </div>
    </form>
  );
}

export function DeleteMetricButton({ slug, id }: { slug: string; id: string }) {
  const t = useTranslations("dashboards.builder");
  const router = useRouter();
  const [pending, start] = useTransition();
  return <ConfirmButton size="sm" variant="ghost" className="text-destructive" disabled={pending} title={t("delete_confirm")} confirmLabel={t("delete")} destructive onConfirm={() => start(async () => { await deleteTenantMetricAction(slug, id); router.refresh(); })}>{t("delete")}</ConfirmButton>;
}

/** Monthly target of a metric: the value in the metric's display unit (currency units for money, % for percent). */
export function TargetForm({ slug, metrics, month }: { slug: string; metrics: { ref: string; label: string; format: string }[]; month: string }) {
  const t = useTranslations("dashboards.builder");
  const router = useRouter();
  const [metric, setMetric] = useState(metrics[0]?.ref ?? "net_revenue");
  const [m, setMonth] = useState(month);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const format = metrics.find((x) => x.ref === metric)?.format ?? "number";
  return (
    <form
      className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_auto] sm:items-end"
      data-testid="target-form"
      onSubmit={(e) => {
        e.preventDefault();
        const n = value.trim() === "" ? null : Number(value.replace(",", "."));
        if (n !== null && !Number.isFinite(n)) return setMsg(t("invalid_target"));
        const target = n === null ? null : format === "money" ? Math.round(n * 100) : format === "percent" ? n / 100 : n;
        start(async () => {
          const r = await setMetricTargetAction(slug, { metric, month: m, target });
          setMsg(r.ok ? t("target_saved") : t("invalid_target"));
          router.refresh();
        });
      }}
    >
      <div className="space-y-1"><Label htmlFor="t-metric">{t("target_metric")}</Label><Select id="t-metric" value={metric} onChange={(e) => setMetric(e.target.value)}>{metrics.map((x) => <option key={x.ref} value={x.ref}>{x.label}</option>)}</Select></div>
      <div className="space-y-1"><Label htmlFor="t-month">{t("target_month")}</Label><Input id="t-month" type="month" value={m} onChange={(e) => setMonth(e.target.value)} required /></div>
      <div className="space-y-1"><Label htmlFor="t-value">{t(`target_value_${format === "money" ? "money" : format === "percent" ? "percent" : "number"}`)}</Label><Input id="t-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("target_clear")} /></div>
      <Button type="submit" size="sm" disabled={pending}>{t("target_save")}</Button>
      {msg && <p className="text-xs text-muted-foreground sm:col-span-4" role="status">{msg}</p>}
    </form>
  );
}
