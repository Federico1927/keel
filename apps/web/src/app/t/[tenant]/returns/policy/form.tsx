"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import type { ReturnAutomation, ReturnPolicy, ReturnWindowRule } from "@keel/core";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from "@keel/ui";
import { saveReturnPolicyAction } from "@/server/actions/returns";

const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
const minor = (v: string) => (v.trim() === "" ? null : Math.round(Number(v.replace(",", ".")) * 100));
const major = (v: number | null) => (v === null ? "" : (v / 100).toFixed(2));

export function PolicyForm({ slug, initial, currency, reasons, productTypes, tags }: { slug: string; initial: ReturnPolicy; currency: string; reasons: { code: string; label: string }[]; productTypes: string[]; tags: string[] }) {
  const t = useTranslations("return_policy");
  const tc = useTranslations("common");
  const tr = useTranslations("returns");
  const [p, setP] = useState<ReturnPolicy>(initial);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const setWindow = (i: number, w: Partial<ReturnWindowRule>) => setP({ ...p, windows: p.windows.map((x, j) => (j === i ? { ...x, ...w } : x)) });
  const setAuto = (i: number, a: Partial<ReturnAutomation>) => setP({ ...p, automations: p.automations.map((x, j) => (j === i ? { ...x, ...a } : x)) });
  const setCond = (i: number, c: Partial<ReturnAutomation["conditions"]>) => setAuto(i, { conditions: { ...p.automations[i]!.conditions, ...c } });
  const move = (i: number, d: -1 | 1) => {
    const a = [...p.automations];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j]!, a[i]!];
    setP({ ...p, automations: a });
  };
  const save = () => start(async () => setResult(await saveReturnPolicyAction(slug, p).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }))));
  return (
    <div className="space-y-4" data-testid="return-policy-form">
      <datalist id="pt-types">{productTypes.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="pt-tags">{tags.map((x) => <option key={x} value={x} />)}</datalist>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("windows")}</CardTitle>
          <CardDescription>{t("windows_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {p.windows.map((w, i) => (
            <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_1fr_6rem_auto]" data-testid="policy-window">
              <Input aria-label={t("countries")} placeholder={t("countries")} value={w.countries.join(", ")} onChange={(e) => setWindow(i, { countries: csv(e.target.value.toUpperCase()).filter((c) => c.length === 2) })} />
              <Input aria-label={t("product_types")} placeholder={t("product_types")} list="pt-types" value={w.productTypes.join(", ")} onChange={(e) => setWindow(i, { productTypes: csv(e.target.value) })} />
              <Input aria-label={t("tags")} placeholder={t("tags")} list="pt-tags" value={w.tags.join(", ")} onChange={(e) => setWindow(i, { tags: csv(e.target.value) })} />
              <Input aria-label={t("days")} type="number" min={0} max={365} value={w.days} onChange={(e) => setWindow(i, { days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />
              <button type="button" aria-label={tc("delete")} onClick={() => setP({ ...p, windows: p.windows.filter((_, j) => j !== i) })} className="rounded p-2 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setP({ ...p, windows: [...p.windows, { countries: [], productTypes: [], tags: [], days: 30 }] })}><Plus className="h-4 w-4" /> {t("add_window")}</Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("exclusions")}</CardTitle>
            <CardDescription>{t("exclusions_hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {(["productTypes", "skuPrefixes", "titleContains", "tags"] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`ex-${k}`}>{t(`ex.${k}`)}</Label>
                <Input id={`ex-${k}`} list={k === "productTypes" ? "pt-types" : k === "tags" ? "pt-tags" : undefined} value={p.exclusions[k].join(", ")} onChange={(e) => setP({ ...p, exclusions: { ...p.exclusions, [k]: csv(e.target.value) } })} />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="ex-final">{t("final_sale")}</Label>
              <Input id="ex-final" type="number" min={0} max={100} placeholder="—" value={p.finalSaleDiscountBps === null ? "" : p.finalSaleDiscountBps / 100} onChange={(e) => setP({ ...p, finalSaleDiscountBps: e.target.value === "" || Number(e.target.value) <= 0 ? null : Math.min(10000, Math.round(Number(e.target.value) * 100)) })} />
              <p className="text-xs text-muted-foreground">{t("final_sale_hint")}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("customers")}</CardTitle>
            <CardDescription>{t("customers_hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.customerLimit !== null} onChange={(e) => setP({ ...p, customerLimit: e.target.checked ? { count: 3, days: 90 } : null })} /> {t("limit_on")}</label>
            {p.customerLimit && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label htmlFor="lim-count">{t("limit_count")}</Label><Input id="lim-count" type="number" min={1} max={100} value={p.customerLimit.count} onChange={(e) => setP({ ...p, customerLimit: { ...p.customerLimit!, count: Math.max(1, Number(e.target.value) || 1) } })} /></div>
                <div className="space-y-1"><Label htmlFor="lim-days">{t("limit_days")}</Label><Input id="lim-days" type="number" min={1} max={730} value={p.customerLimit.days} onChange={(e) => setP({ ...p, customerLimit: { ...p.customerLimit!, days: Math.max(1, Number(e.target.value) || 1) } })} /></div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 border-t pt-3">
              <div className="space-y-1"><Label htmlFor="risk-watch">{t("risk_watch")}</Label><Input id="risk-watch" type="number" min={1} max={100} value={p.risk.watchRateBps / 100} onChange={(e) => setP({ ...p, risk: { ...p.risk, watchRateBps: Math.round((Number(e.target.value) || 1) * 100) } })} /></div>
              <div className="space-y-1"><Label htmlFor="risk-high">{t("risk_high")}</Label><Input id="risk-high" type="number" min={1} max={100} value={p.risk.highRateBps / 100} onChange={(e) => setP({ ...p, risk: { ...p.risk, highRateBps: Math.round((Number(e.target.value) || 1) * 100) } })} /></div>
              <div className="space-y-1"><Label htmlFor="risk-min">{t("risk_min_returns")}</Label><Input id="risk-min" type="number" min={1} max={50} value={p.risk.minReturns} onChange={(e) => setP({ ...p, risk: { ...p.risk, minReturns: Math.max(1, Number(e.target.value) || 1) } })} /></div>
              <div className="space-y-1"><Label htmlFor="risk-quick">{t("risk_quick")}</Label><Input id="risk-quick" type="number" min={1} max={60} value={p.risk.quickReturnDays} onChange={(e) => setP({ ...p, risk: { ...p.risk, quickReturnDays: Math.max(1, Number(e.target.value) || 1) } })} /></div>
              <div className="col-span-2 space-y-1"><Label htmlFor="risk-value">{t("risk_value", { currency })}</Label><Input id="risk-value" type="number" min={0} step="0.01" value={major(p.risk.highValueMinor)} onChange={(e) => setP({ ...p, risk: { ...p.risk, highValueMinor: minor(e.target.value) ?? 0 } })} /></div>
            </div>
            <p className="text-xs text-muted-foreground">{t("risk_hint")}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("automations")}</CardTitle>
          <CardDescription>{t("automations_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {p.automations.map((a, i) => (
            <div key={a.id} className="space-y-2 rounded-md border p-3" data-testid="policy-automation">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground tabular">{i + 1}.</span>
                <Input className="min-w-40 flex-1" aria-label={t("auto_name")} value={a.name} onChange={(e) => setAuto(i, { name: e.target.value })} />
                <Select aria-label={t("auto_action")} value={a.action} onChange={(e) => setAuto(i, { action: e.target.value as ReturnAutomation["action"] })} className="w-48">
                  {(["approve", "reject", "flag", "set_fault", "returnless"] as const).map((x) => <option key={x} value={x}>{t(`actions.${x}`)}</option>)}
                </Select>
                {a.action === "set_fault" && (
                  <Select aria-label={t("auto_fault")} value={a.fault ?? "customer"} onChange={(e) => setAuto(i, { fault: e.target.value as "customer" })} className="w-40">
                    {(["merchant", "customer", "undetermined"] as const).map((x) => <option key={x} value={x}>{t(`faults.${x}`)}</option>)}
                  </Select>
                )}
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={a.active} onChange={(e) => setAuto(i, { active: e.target.checked })} /> {t("active")}</label>
                <button type="button" className="px-1 text-xs" aria-label={t("up")} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="px-1 text-xs" aria-label={t("down")} onClick={() => move(i, 1)}>↓</button>
                <button type="button" aria-label={tc("delete")} onClick={() => setP({ ...p, automations: p.automations.filter((_, j) => j !== i) })} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1"><Label className="text-xs" htmlFor={`a-max-${i}`}>{t("cond.max_amount", { currency })}</Label><Input id={`a-max-${i}`} type="number" min={0} step="0.01" value={major(a.conditions.maxAmountMinor)} onChange={(e) => setCond(i, { maxAmountMinor: minor(e.target.value) })} /></div>
                <div className="space-y-1"><Label className="text-xs" htmlFor={`a-min-${i}`}>{t("cond.min_amount", { currency })}</Label><Input id={`a-min-${i}`} type="number" min={0} step="0.01" value={major(a.conditions.minAmountMinor)} onChange={(e) => setCond(i, { minAmountMinor: minor(e.target.value) })} /></div>
                <div className="space-y-1"><Label className="text-xs" htmlFor={`a-types-${i}`}>{t("cond.product_types")}</Label><Input id={`a-types-${i}`} list="pt-types" value={a.conditions.productTypes.join(", ")} onChange={(e) => setCond(i, { productTypes: csv(e.target.value) })} /></div>
                <div className="space-y-1"><Label className="text-xs" htmlFor={`a-maxrisk-${i}`}>{t("cond.max_risk")}</Label><Select id={`a-maxrisk-${i}`} value={a.conditions.maxRisk ?? ""} onChange={(e) => setCond(i, { maxRisk: (e.target.value || null) as "none" | null })}><option value="">—</option>{(["none", "watch", "high"] as const).map((x) => <option key={x} value={x}>{t(`risk.${x}`)}</option>)}</Select></div>
                <div className="space-y-1"><Label className="text-xs" htmlFor={`a-minrisk-${i}`}>{t("cond.min_risk")}</Label><Select id={`a-minrisk-${i}`} value={a.conditions.minRisk ?? ""} onChange={(e) => setCond(i, { minRisk: (e.target.value || null) as "none" | null })}><option value="">—</option>{(["none", "watch", "high"] as const).map((x) => <option key={x} value={x}>{t(`risk.${x}`)}</option>)}</Select></div>
                <label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" checked={a.conditions.firstReturnOnly} onChange={(e) => setCond(i, { firstReturnOnly: e.target.checked })} /> {t("cond.first_only")}</label>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">{t("cond.reasons")}:</span>
                {reasons.map((r) => <label key={r.code} className="flex items-center gap-1"><input type="checkbox" checked={a.conditions.reasonCodes.includes(r.code)} onChange={() => setCond(i, { reasonCodes: a.conditions.reasonCodes.includes(r.code) ? a.conditions.reasonCodes.filter((x) => x !== r.code) : [...a.conditions.reasonCodes, r.code] })} /> {r.label}</label>)}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">{t("cond.resolutions")}:</span>
                {(["refund", "exchange", "voucher"] as const).map((r) => <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={a.conditions.resolutions.includes(r)} onChange={() => setCond(i, { resolutions: a.conditions.resolutions.includes(r) ? a.conditions.resolutions.filter((x) => x !== r) : [...a.conditions.resolutions, r] })} /> {tr(`resolution.${r}`)}</label>)}
                <span className="ml-2 text-muted-foreground">{t("cond.sources")}:</span>
                {(["portal", "staff"] as const).map((r) => <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={a.conditions.sources.includes(r)} onChange={() => setCond(i, { sources: a.conditions.sources.includes(r) ? a.conditions.sources.filter((x) => x !== r) : [...a.conditions.sources, r] })} /> {tr(`source.${r}`)}</label>)}
              </div>
              <Input aria-label={t("auto_note")} placeholder={t("auto_note")} value={a.note ?? ""} onChange={(e) => setAuto(i, { note: e.target.value || null })} />
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" data-testid="add-automation" onClick={() => setP({ ...p, automations: [...p.automations, { id: `a${Date.now().toString(36)}`, name: t("new_automation"), active: true, trigger: "created", action: "flag", fault: null, note: null, conditions: { maxAmountMinor: null, minAmountMinor: null, reasonCodes: [], resolutions: [], sources: [], productTypes: [], maxRisk: null, minRisk: null, firstReturnOnly: false } }] })}><Plus className="h-4 w-4" /> {t("add_automation")}</Button>
        </CardContent>
      </Card>

      {result && <Alert variant={result.ok ? "info" : "destructive"}><AlertDescription>{result.ok ? tc("saved") : tc(`errors.${result.error}`)}</AlertDescription></Alert>}
      <Button onClick={save} disabled={pending} data-testid="policy-save">{tc("save")}</Button>
    </div>
  );
}
