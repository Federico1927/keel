"use client";
import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, Button, Checkbox, Input, Label, Select } from "@hullwise/ui";
import { applyTransferAction, deleteBundleComponentAction, deleteDemandEventAction, generateDraftsAction, saveBundleComponentAction, saveDemandEventAction, setForecastOverrideAction } from "@/server/actions/planning";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "@/components/charts/theme";

export interface ReplenishmentView {
  variantId: string;
  productId: string;
  label: string;
  sku: string | null;
  supplier: string | null;
  available: number;
  incoming: number;
  backordered: number;
  daily: string;
  cover: string;
  stockout: string | null;
  urgent: boolean;
  safetyStock: number;
  reorderPoint: number;
  quantity: number;
  constraint: string | null;
  cost: string;
  inDraft: number;
  shouldOrder: boolean;
}

/** Reorder table with selection and "create draft POs" (one PO per supplier). */
export function ReplenishmentTable({ slug, rows }: { slug: string; rows: ReplenishmentView[] }) {
  const t = useTranslations("planning.replenishment");
  const tc = useTranslations("common");
  const selectable = rows.filter((r) => r.shouldOrder && r.supplier && r.inDraft === 0).map((r) => r.variantId);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectable));
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; created?: { id: string; number: string }[]; error?: string } | null>(null);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending || selected.size === 0}
          data-testid="generate-drafts"
          onClick={() =>
            start(async () => {
              const r = await generateDraftsAction(slug, [...selected]);
              setResult(r.ok ? { ok: true, created: r.data?.created ?? [] } : { ok: false, error: r.error });
              if (r.ok) setSelected(new Set());
            })
          }
        >
          {t("generate", { n: selected.size })}
        </Button>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setSelected(selected.size ? new Set() : new Set(selectable))}>
          {selected.size ? t("select_none") : t("select_all")}
        </button>
        {result?.ok && (
          <span className="text-sm" data-testid="drafts-result">
            {result.created!.length === 0 ? t("none_created") : t("created", { n: result.created!.length })}{" "}
            {result.created!.map((c) => (
              <Link key={c.id} href={`/t/${slug}/purchasing/${c.id}`} className="mr-2 text-primary underline">{c.number}</Link>
            ))}
          </span>
        )}
        {result && !result.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${result.error}`)}</AlertDescription></Alert>}
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-8 p-2" />
              <th className="p-2 text-left font-medium">{t("columns.variant")}</th>
              <th className="hidden p-2 text-left font-medium md:table-cell">{t("columns.supplier")}</th>
              <th className="p-2 text-right font-medium">{t("columns.position")}</th>
              <th className="hidden p-2 text-right font-medium lg:table-cell">{t("columns.daily")}</th>
              <th className="p-2 text-left font-medium">{t("columns.stockout")}</th>
              <th className="hidden p-2 text-right font-medium lg:table-cell">{t("columns.safety")}</th>
              <th className="hidden p-2 text-right font-medium lg:table-cell">{t("columns.rop")}</th>
              <th className="p-2 text-right font-medium">{t("columns.order")}</th>
              <th className="hidden p-2 text-right font-medium md:table-cell">{t("columns.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const canSelect = selectable.includes(r.variantId);
              return (
                <tr key={r.variantId} className="border-b last:border-0" data-testid="replenishment-row">
                  <td className="p-2">{canSelect && <Checkbox aria-label={r.label} checked={selected.has(r.variantId)} onCheckedChange={() => toggle(r.variantId)} />}</td>
                  <td className="p-2">
                    <Link href={`/t/${slug}/products/${r.productId}`} className="font-medium hover:underline">{r.label}</Link>
                    <p className="text-xs text-muted-foreground">{r.sku}</p>
                  </td>
                  <td className="hidden p-2 text-muted-foreground md:table-cell">{r.supplier ?? t("no_supplier")}</td>
                  <td className="p-2 text-right tabular" title={t("position_hint", { available: r.available, incoming: r.incoming, backordered: r.backordered })}>
                    {r.available}
                    {r.incoming > 0 && <span className="text-xs text-muted-foreground"> +{r.incoming}</span>}
                    {r.backordered > 0 && <span className="text-xs text-destructive"> −{r.backordered}</span>}
                  </td>
                  <td className="hidden p-2 text-right tabular lg:table-cell">{r.daily}</td>
                  <td className={`p-2 ${r.urgent ? "font-medium text-destructive" : "text-muted-foreground"}`}>{r.stockout ?? "—"}<span className="block text-xs text-muted-foreground">{r.cover}</span></td>
                  <td className="hidden p-2 text-right tabular lg:table-cell">{r.safetyStock}</td>
                  <td className="hidden p-2 text-right tabular lg:table-cell">{r.reorderPoint}</td>
                  <td className="p-2 text-right tabular">
                    {r.shouldOrder ? <span className="font-semibold">{r.quantity}</span> : "—"}
                    {r.constraint && <span className="block text-xs text-muted-foreground">{r.constraint}</span>}
                    {r.inDraft > 0 && <span className="block text-xs text-info">{t("in_draft", { n: r.inDraft })}</span>}
                  </td>
                  <td className="hidden p-2 text-right tabular md:table-cell">{r.shouldOrder ? r.cost : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ForecastChart({ data, locale, labels }: { data: { month: string; history: number | null; forecast: number | null }[]; locale: string; labels: { history: string; forecast: string } }) {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  const label = (m: string) => fmt.format(new Date(`${m}-01T00:00:00Z`));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="month" tickFormatter={label} tick={AXIS_TICK} stroke={CHART_GRID} minTickGap={16} />
          <YAxis tick={AXIS_TICK} stroke={CHART_GRID} width={40} allowDecimals={false} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={(m) => label(String(m))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="history" name={labels.history} fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
          <Line dataKey="forecast" name={labels.forecast} stroke={CHART_COLORS[1]} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CashChart({ data, locale, currency, labels }: { data: { month: string; committedMinor: number; plannedMinor: number }[]; locale: string; currency: string; labels: { committed: string; planned: string } }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  const rows = data.map((d) => ({ month: d.month, committed: d.committedMinor / 100, planned: d.plannedMinor / 100 }));
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => fmt.format(new Date(`${m}-01T00:00:00Z`))} tick={AXIS_TICK} stroke={CHART_GRID} />
          <YAxis tick={AXIS_TICK} stroke={CHART_GRID} width={64} tickFormatter={(v: number) => money.format(v)} />
          <Tooltip {...TOOLTIP_PROPS} formatter={(v) => money.format(Number(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="committed" name={labels.committed} stackId="a" fill={CHART_COLORS[0]} />
          <Bar dataKey="planned" name={labels.planned} stackId="a" fill={CHART_COLORS[1]} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DemandEventForm({ slug, productTypes, defaultMonth }: { slug: string; productTypes: string[]; defaultMonth: string }) {
  const t = useTranslations("planning.events");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveDemandEventAction.bind(null, slug), null);
  const [scope, setScope] = useState("all");
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2" data-testid="demand-event-form">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="ev-name" className="text-xs">{t("name")}</Label>
        <Input id="ev-name" name="name" required minLength={2} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ev-month" className="text-xs">{t("month")}</Label>
        <Input id="ev-month" name="month" type="month" defaultValue={defaultMonth} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ev-uplift" className="text-xs">{t("uplift")}</Label>
        <Input id="ev-uplift" name="upliftPct" type="number" step="1" min={-90} max={500} defaultValue={30} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ev-scope" className="text-xs">{t("scope")}</Label>
        <Select id="ev-scope" name="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">{t("scopes.all")}</option>
          <option value="product_type">{t("scopes.product_type")}</option>
        </Select>
      </div>
      {scope === "product_type" && (
        <div className="space-y-1">
          <Label htmlFor="ev-value" className="text-xs">{t("scopes.product_type")}</Label>
          <Select id="ev-value" name="scopeValue">
            {productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </div>
      )}
      {state && <Alert variant={state.ok ? "info" : "destructive"} className="sm:col-span-2"><AlertDescription>{state.ok ? tc("saved") : tc(`errors.${state.error}`)}</AlertDescription></Alert>}
      <Button type="submit" size="sm" disabled={pending} className="sm:col-span-2">{t("add")}</Button>
    </form>
  );
}

export function DeleteEventButton({ slug, id }: { slug: string; id: string }) {
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  return (
    <button type="button" aria-label={tc("delete")} disabled={pending} onClick={() => start(() => void deleteDemandEventAction(slug, id))} className="rounded p-1 text-muted-foreground hover:text-destructive">
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

/** One month cell of the forecast table: shows the forecast, edits the override. */
export function OverrideCell({ slug, variantId, month, units, overridden }: { slug: string; variantId: string; month: string; units: number; overridden: boolean }) {
  const t = useTranslations("planning.forecast");
  const [state, action, pending] = useActionState(setForecastOverrideAction.bind(null, slug), null);
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <button type="button" className={`tabular ${overridden ? "font-semibold text-primary underline decoration-dotted" : "hover:underline"}`} title={overridden ? t("overridden") : t("click_to_override")} onClick={() => setEditing(true)}>
        {units}
      </button>
    );
  return (
    <form action={async (fd) => { await action(fd); setEditing(false); }} className="flex items-center justify-end gap-1">
      <input type="hidden" name="variantId" value={variantId} />
      <input type="hidden" name="month" value={month} />
      <input name="units" type="number" min={0} defaultValue={overridden ? units : ""} placeholder={String(units)} aria-label={t("override_for", { month })} className="h-7 w-16 rounded border border-input bg-card px-1 text-right text-xs" autoFocus />
      <button type="submit" disabled={pending} className="text-xs text-primary">{t("ok")}</button>
      {state && !state.ok && <span className="text-xs text-destructive">!</span>}
    </form>
  );
}

export function TransferButton({ slug, input }: { slug: string; input: { variantId: string; fromLocationId: string; toLocationId: string; units: number } }) {
  const t = useTranslations("planning.transfers");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  if (result === "ok") return <span className="text-xs text-success">{t("done")}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
        const r = await applyTransferAction(slug, input);
        setResult(r.ok ? "ok" : r.error);
      })}>{t("apply")}</Button>
      {result && result !== "ok" && <span className="text-xs text-destructive">{tc(`errors.${result}`)}</span>}
    </span>
  );
}

export function BundleForm({ slug, variants }: { slug: string; variants: { id: string; label: string }[] }) {
  const t = useTranslations("planning.bundles");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveBundleComponentAction.bind(null, slug), null);
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="b-parent" className="text-xs">{t("parent")}</Label>
        <Select id="b-parent" name="parentVariantId">{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="b-comp" className="text-xs">{t("component")}</Label>
        <Select id="b-comp" name="componentVariantId">{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="b-qty" className="text-xs">{t("quantity")}</Label>
        <Input id="b-qty" name="quantity" type="number" min={1} defaultValue={1} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="b-kind" className="text-xs">{t("kind")}</Label>
        <Select id="b-kind" name="kind" defaultValue="bundle">
          <option value="bundle">{t("kinds.bundle")}</option>
          <option value="bom">{t("kinds.bom")}</option>
        </Select>
      </div>
      {state && <Alert variant={state.ok ? "info" : "destructive"} className="sm:col-span-2"><AlertDescription>{state.ok ? tc("saved") : tc(`errors.${state.error}`)}</AlertDescription></Alert>}
      <Button type="submit" size="sm" disabled={pending} className="sm:col-span-2">{t("add")}</Button>
    </form>
  );
}

export function DeleteComponentButton({ slug, parentVariantId, componentVariantId }: { slug: string; parentVariantId: string; componentVariantId: string }) {
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  return (
    <button type="button" aria-label={tc("delete")} disabled={pending} onClick={() => start(() => void deleteBundleComponentAction(slug, parentVariantId, componentVariantId))} className="rounded p-1 text-muted-foreground hover:text-destructive">
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
