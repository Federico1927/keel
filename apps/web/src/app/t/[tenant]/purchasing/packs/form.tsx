"use client";
import { useActionState, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { packUnits } from "@hullwise/core";
import { Alert, AlertDescription, Button, Checkbox, Input, Label, Select } from "@hullwise/ui";
import { deleteCasePackAction, saveCasePackAction } from "@/server/actions/purchasing-terms";

interface PackInput {
  id: string;
  name: string;
  optionName: string;
  productId: string | null;
  units: Record<string, number>;
  isActive: boolean;
}

/** Create or edit a pack: pick an option of the catalogue, set units per value (custom values allowed). */
export function CasePackForm({ slug, options, products, pack }: { slug: string; options: { name: string; values: string[] }[]; products: { id: string; title: string; options: string[] }[]; pack?: PackInput }) {
  const t = useTranslations("case_packs");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(saveCasePackAction.bind(null, slug), null);
  const [optionName, setOptionName] = useState(pack?.optionName ?? options[0]?.name ?? "");
  const known = options.find((o) => o.name.toLowerCase() === optionName.toLowerCase())?.values ?? [];
  const [rows, setRows] = useState<{ value: string; units: string }[]>(() => {
    const base = pack ? Object.entries(pack.units).map(([value, n]) => ({ value, units: String(n) })) : [];
    return base;
  });
  const [custom, setCustom] = useState("");
  const shown = useMemo(() => {
    const out = [...rows];
    for (const v of known) if (!out.some((r) => r.value.toLowerCase() === v.toLowerCase())) out.push({ value: v, units: "" });
    return out;
  }, [rows, known]);
  const set = (value: string, units: string) => setRows((rs) => (rs.some((r) => r.value === value) ? rs.map((r) => (r.value === value ? { ...r, units } : r)) : [...rs, { value, units }]));
  const total = packUnits({ units: Object.fromEntries(shown.map((r) => [r.value, Number(r.units) || 0])) });
  const fitting = products.filter((p) => p.options.includes(optionName.toLowerCase()));
  const prefix = pack?.id ?? "new";
  return (
    <form action={action} className="space-y-3" data-testid="case-pack-form">
      {pack && <input type="hidden" name="id" value={pack.id} />}
      <div className="space-y-1.5">
        <Label htmlFor={`pack-name-${prefix}`}>{t("name")}</Label>
        <Input id={`pack-name-${prefix}`} name="name" defaultValue={pack?.name ?? ""} required maxLength={80} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`pack-option-${prefix}`}>{t("option")}</Label>
          <Select id={`pack-option-${prefix}`} name="optionName" value={optionName} onChange={(e) => { setOptionName(e.target.value); setRows([]); }}>
            {options.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            {pack && !options.some((o) => o.name.toLowerCase() === pack.optionName.toLowerCase()) && <option value={pack.optionName}>{pack.optionName}</option>}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`pack-product-${prefix}`}>{t("product")}</Label>
          <Select id={`pack-product-${prefix}`} name="productId" defaultValue={pack?.productId ?? ""}>
            <option value="">{t("all_products")}</option>
            {fitting.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </Select>
        </div>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t("units")}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((r) => (
            <label key={r.value} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
              <span className="min-w-0 flex-1 truncate">{r.value}</span>
              <Input size="sm" type="number" min={0} max={10000} name={`unit_${r.value}`} value={r.units} onChange={(e) => set(r.value, e.target.value)} className="w-16 text-right" aria-label={t("units_for", { value: r.value })} />
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Input size="sm" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t("custom_value")} aria-label={t("custom_value")} maxLength={60} />
          <Button type="button" size="sm" variant="outline" disabled={!custom.trim()} onClick={() => { set(custom.trim(), "1"); setCustom(""); }} aria-label={t("add_value")}><Plus /></Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("units_per_pack", { n: total })}</p>
      </fieldset>
      {pack && (
        <label className="flex items-center gap-2 text-sm">
          <input type="hidden" name="hasActive" value="1" />
          <Checkbox name="isActive" defaultChecked={pack.isActive} /> {t("active")}
        </label>
      )}
      {state && !state.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
      {state?.ok && <Alert variant="info"><AlertDescription>{tc("saved")}</AlertDescription></Alert>}
      <Button type="submit" size="sm" disabled={pending || total === 0}>{tc("save")}</Button>
    </form>
  );
}

export function DeletePackButton({ slug, id }: { slug: string; id: string }) {
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  return (
    <button type="button" aria-label={tc("delete")} disabled={pending} onClick={() => start(() => void deleteCasePackAction(slug, id))} className="rounded p-1 text-muted-foreground hover:text-destructive">
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
