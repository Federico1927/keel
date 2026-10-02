"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { allocateByShare, formatMoney, packAllocation, packGroups, type CasePackDef } from "@hullwise/core";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, DataList, Input, Label, Select, cn } from "@hullwise/ui";
import { createPoFromMixAction } from "@/server/actions/purchasing-terms";

interface MixVariant {
  id: string;
  title: string;
  sku: string | null;
  optionValues: Record<string, string>;
  share: number;
  suggested: number;
  costMinor: number | null;
}

/**
 * Allocation preview: a total split by sales share (optionally in multiples), or N case packs per
 * option group (pre-filled with the replenishment suggestion). The server recomputes the same
 * allocation from these inputs when the draft PO is created.
 */
export function MixPlanner({ slug, productId, lookbackDays, currency, variants, packs, suggestions, suppliers, defaultSupplierId, locations }: { slug: string; productId: string; lookbackDays: number; currency: string; variants: MixVariant[]; packs: (CasePackDef & { id: string; totalUnits: number })[]; suggestions: Record<string, Record<string, number>>; suppliers: { id: string; name: string }[]; defaultSupplierId: string; locations: { id: string; name: string; isDefault: boolean }[] }) {
  const t = useTranslations("option_mix.planner");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [state, action, pending] = useActionState(createPoFromMixAction.bind(null, slug, productId), null);
  const suggestedTotal = variants.reduce((s, v) => s + v.suggested, 0);
  const [mode, setMode] = useState<"units" | "packs">(packs.length ? "packs" : "units");
  const [total, setTotal] = useState(String(suggestedTotal || 50));
  const [multiple, setMultiple] = useState("");
  const [packId, setPackId] = useState(packs[0]?.id ?? "");
  const pack = packs.find((p) => p.id === packId);
  const groups = useMemo(() => (pack ? packGroups(variants, pack.optionName) : []), [pack, variants]);
  const [packsByGroup, setPacksByGroup] = useState<Record<string, number>>(() => suggestions[packs[0]?.id ?? ""] ?? {});
  useEffect(() => {
    if (state?.ok && state.data?.id) router.push(`/t/${slug}/purchasing/${state.data.id}`);
  }, [state, router, slug]);
  const allocation = useMemo<Record<string, number>>(() => {
    if (mode === "units") return allocateByShare(Math.max(0, Math.floor(Number(total) || 0)), variants.map((v) => ({ key: v.id, share: v.share })), { multiple: Number(multiple) || null });
    if (!pack) return {};
    const out: Record<string, number> = {};
    for (const g of groups) Object.assign(out, packAllocation(pack, g, packsByGroup[g.key] ?? 0));
    return out;
  }, [mode, total, multiple, variants, pack, groups, packsByGroup]);
  const units = Object.values(allocation).reduce((s, n) => s + n, 0);
  const value = variants.reduce((s, v) => s + (allocation[v.id] ?? 0) * (v.costMinor ?? 0), 0);
  const payload = mode === "units" ? { mode, totalUnits: Math.max(0, Math.floor(Number(total) || 0)), multiple: Number(multiple) || null } : { mode, packId, packsByGroup: Object.fromEntries(groups.map((g) => [g.key, packsByGroup[g.key] ?? 0])) };
  const label = (values: Record<string, string>) => Object.values(values).join(" / ") || t("single_group");
  return (
    <Card data-testid="mix-planner">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {(["units", "packs"] as const).map((m) => (
            <Button key={m} type="button" role="radio" aria-checked={mode === m} size="sm" variant={mode === m ? "default" : "outline"} disabled={m === "packs" && packs.length === 0} onClick={() => setMode(m)}>{t(`mode.${m}`)}</Button>
          ))}
        </div>
        {mode === "units" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="mix-total">{t("total_units")}</Label>
              <Input id="mix-total" type="number" min={1} value={total} onChange={(e) => setTotal(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mix-multiple">{t("multiple")}</Label>
              <Input id="mix-multiple" type="number" min={1} value={multiple} onChange={(e) => setMultiple(e.target.value)} placeholder="1" />
            </div>
            <p className="self-end text-xs text-muted-foreground">{t("suggested_total", { n: suggestedTotal })}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5 sm:w-80">
              <Label htmlFor="mix-pack">{t("pack")}</Label>
              <Select id="mix-pack" value={packId} onChange={(e) => { setPackId(e.target.value); setPacksByGroup(suggestions[e.target.value] ?? {}); }}>
                {packs.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.optionName} ({p.totalUnits})</option>)}
              </Select>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                <label key={g.key} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
                  <span className="min-w-0 truncate">{label(g.values)}</span>
                  <span className="flex items-center gap-1">
                    <Input size="sm" type="number" min={0} value={packsByGroup[g.key] ?? 0} onChange={(e) => setPacksByGroup((m) => ({ ...m, [g.key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))} className="w-16 text-right" aria-label={t("packs_for", { group: label(g.values) })} data-testid="mix-packs-input" />
                    <span className="text-xs text-muted-foreground">{t("cartons")}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="-mx-(--density-card) border-y">
          <DataList
            rows={variants}
            rowKey={(v) => v.id}
            rowProps={(v) => ({ className: cn(!(allocation[v.id] ?? 0) && "text-muted-foreground") })}
            columns={[
              { key: "variant", header: t("variant"), mobile: "title", cell: (v) => <>{v.title} <span className="text-xs font-normal text-muted-foreground">{v.sku}</span></> },
              { key: "quantity", header: t("quantity"), mobile: "badge", align: "right", className: "tabular", cell: (v) => <span data-testid="mix-qty">{allocation[v.id] ?? 0}</span> },
              { key: "cost", header: t("cost"), align: "right", className: "tabular", cell: (v) => formatMoney((allocation[v.id] ?? 0) * (v.costMinor ?? 0), currency, locale) },
            ]}
            footer={{
              variant: t("total"),
              quantity: <span data-testid="mix-total-units">{units}</span>,
              cost: formatMoney(value, currency, locale),
            }}
          />
        </div>
        <form action={action} className="grid gap-3 border-t pt-4 sm:grid-cols-3">
          <input type="hidden" name="allocation" value={JSON.stringify(payload)} />
          <input type="hidden" name="lookbackDays" value={lookbackDays} />
          <div className="space-y-1.5">
            <Label htmlFor="mix-supplier">{t("supplier")}</Label>
            <Select id="mix-supplier" name="supplierId" defaultValue={defaultSupplierId}>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mix-location">{t("destination")}</Label>
            <Select id="mix-location" name="destinationLocationId" defaultValue={locations.find((l) => l.isDefault)?.id ?? locations[0]?.id}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full" disabled={pending || units === 0} data-testid="mix-create-po">{t("create_po")}</Button>
          </div>
          {state && !state.ok && <Alert variant="destructive" className="sm:col-span-3"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
        </form>
      </CardContent>
    </Card>
  );
}
