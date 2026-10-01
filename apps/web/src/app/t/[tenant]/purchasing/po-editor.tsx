"use client";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@keel/core";
import { Plus, Search, Trash2 } from "lucide-react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@keel/ui";
import type { PoVariantOption } from "@keel/services";
import { createPo, searchPoVariantsAction, updatePo } from "@/server/actions/purchasing";
import { RiskBadge } from "@/components/risk-badge";
import { lineFromOption, newLineKey, type EditorInitial, type EditorLine } from "./po-lines";

/**
 * Purchase order editor (new and edit): lines from any variant (search by SKU or title), from the
 * reorder suggestions, or free text (packaging, samples, services) with quantity and cost.
 */
export function PoEditor({ slug, poId, suppliers, locations, currency, initial, suggestions, supplierLocked }: { slug: string; poId?: string; suppliers: { id: string; name: string }[]; locations: { id: string; name: string }[]; currency: string; initial: EditorInitial; suggestions: PoVariantOption[]; supplierLocked?: boolean }) {
  const t = useTranslations("po_editor");
  const tn = useTranslations("po_new");
  const tc = useTranslations("common");
  const router = useRouter();
  const [state, action, pending] = useActionState(poId ? updatePo.bind(null, slug, poId) : createPo.bind(null, slug), null);
  const [supplierId, setSupplierId] = useState(initial.supplierId || suppliers[0]?.id || "");
  const [lines, setLines] = useState<EditorLine[]>(initial.lines);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PoVariantOption[]>([]);
  const [searching, startSearch] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (state?.ok && state.data?.id) router.push(`/t/${slug}/purchasing/${state.data.id}`);
  }, [state, router, slug]);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => startSearch(async () => setResults(await searchPoVariantsAction(slug, q))), 250);
  }, [q, slug]);
  const inLines = useMemo(() => new Set(lines.map((l) => l.variantId).filter(Boolean)), [lines]);
  const add = (o: PoVariantOption, qty: number) => setLines((ls) => (ls.some((l) => l.variantId === o.variantId) ? ls : [...ls, lineFromOption(o, supplierId, qty)]));
  const update = (key: string, patch: Partial<EditorLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const valid = lines.filter((l) => Number(l.quantity) > 0 && (l.variantId || l.description.trim()));
  const total = valid.reduce((s, l) => s + Number(l.quantity) * Number(l.unitCost || 0), 0);
  const payload = JSON.stringify(valid.map((l) => ({ variantId: l.variantId, description: l.variantId ? null : l.description.trim(), quantity: Math.floor(Number(l.quantity)), unitCost: Number(l.unitCost || 0) })));
  const locale = useLocale();
  const money = (n: number) => formatMoney(Math.round(n * 100), currency, locale);
  const pendingSuggestions = suggestions.filter((s) => !inLines.has(s.variantId));
  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="lines" value={payload} />
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="po-supplier">{tn("supplier")}</Label>
            {supplierLocked && <input type="hidden" name="supplierId" value={supplierId} />}
            <Select id="po-supplier" name={supplierLocked ? undefined : "supplierId"} required value={supplierId} disabled={supplierLocked} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-location">{tn("destination")}</Label>
            <Select id="po-location" name="destinationLocationId" defaultValue={initial.destinationLocationId}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-expected">{tn("expected")}</Label>
            <Input id="po-expected" name="expectedAt" type="date" defaultValue={initial.expectedAt} />
          </div>
          <div className="space-y-1.5 sm:col-span-4">
            <Label htmlFor="po-notes">{tn("notes")}</Label>
            <Textarea id="po-notes" name="notes" rows={2} defaultValue={initial.notes} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">{t("lines")}</CardTitle>
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search_placeholder")} aria-label={t("search_placeholder")} className="w-72 max-w-full pl-8" data-testid="po-variant-search" />
              {q.trim().length >= 2 && (
                <div className="absolute right-0 z-20 mt-1 max-h-72 w-[22rem] max-w-[90vw] overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
                  {searching && results.length === 0 && <p className="p-2 text-muted-foreground">{tc("loading")}</p>}
                  {!searching && results.length === 0 && <p className="p-2 text-muted-foreground">{t("no_results")}</p>}
                  {results.map((o) => (
                    <button key={o.variantId} type="button" disabled={inLines.has(o.variantId)} onClick={() => { add(o, Math.max(1, o.suggested)); setQ(""); }} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50" data-testid="po-variant-result">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{o.label}</span>
                        <span className="block text-xs text-muted-foreground">{o.sku} · {t("available_n", { n: o.available })}</span>
                      </span>
                      <Plus className="h-4 w-4 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button type="button" variant="outline" onClick={() => setLines((ls) => [...ls, { key: newLineKey(), variantId: null, label: "", sku: null, description: "", quantity: "1", unitCost: "0.00", risk: null, daysOfCover: null, available: null }])} data-testid="po-add-free-text">
              <Plus /> {t("add_free_text")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tn("line.variant")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{tn("line.available")}</TableHead>
                <TableHead className="hidden md:table-cell">{tn("line.cover")}</TableHead>
                <TableHead className="text-right">{tn("line.quantity")}</TableHead>
                <TableHead className="text-right">{tn("line.unit_cost", { currency })}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">{t("line_total")}</TableHead>
                <TableHead className="w-10"><span className="sr-only">{tc("delete")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.key} data-testid="po-line">
                  <TableCell>
                    {l.variantId ? (
                      <>
                        <p className="font-medium">{l.label}</p>
                        <p className="text-xs text-muted-foreground">{l.sku}</p>
                      </>
                    ) : (
                      <Input size="sm" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} placeholder={t("free_text_placeholder")} aria-label={t("free_text_placeholder")} maxLength={300} className="min-w-40" />
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right tabular md:table-cell">{l.available ?? "—"}</TableCell>
                  <TableCell className="hidden md:table-cell">{l.risk ? <RiskBadge risk={l.risk} days={l.daysOfCover} /> : <span className="text-xs text-muted-foreground">{t("free_text")}</span>}</TableCell>
                  <TableCell className="text-right"><Input size="sm" type="number" min={0} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} className="ml-auto w-20 text-right" aria-label={tn("line.quantity")} /></TableCell>
                  <TableCell className="text-right"><Input size="sm" type="number" step="0.01" min={0} value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} className="ml-auto w-24 text-right" aria-label={tn("line.unit_cost", { currency })} /></TableCell>
                  <TableCell className="hidden text-right tabular sm:table-cell">{money(Number(l.quantity || 0) * Number(l.unitCost || 0))}</TableCell>
                  <TableCell>
                    <button type="button" aria-label={tc("delete")} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="rounded p-1 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
              {lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">{t("empty")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex justify-end border-t p-4 text-sm font-medium">
            <span className="mr-3 text-muted-foreground">{t("total")}</span>
            <span className="tabular" data-testid="po-editor-total">{money(total)}</span>
          </div>
        </CardContent>
      </Card>
      {pendingSuggestions.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">{t("suggestions")}</CardTitle>
            <Button type="button" size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, ...pendingSuggestions.filter((s) => s.suggested > 0).map((s) => lineFromOption(s, supplierId, s.suggested))])}>{t("add_all")}</Button>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {pendingSuggestions.slice(0, 40).map((s) => (
              <div key={s.variantId} className="flex items-center justify-between gap-2 rounded border p-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.sku} · {t("available_n", { n: s.available })}{s.suggested > 0 ? ` · ${t("suggested_n", { n: s.suggested })}` : ""}</span>
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => add(s, Math.max(1, s.suggested))} aria-label={t("add")}><Plus /></Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {state && !state.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || valid.length === 0} data-testid="po-editor-submit">{poId ? t("save") : tn("create")}</Button>
      </div>
    </form>
  );
}
