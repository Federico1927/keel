"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import type { PortalField, ReturnPortalConfig } from "@hullwise/core";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Textarea, cn } from "@hullwise/ui";
import { saveReturnBehaviourAction, savePortalConfigAction } from "@/server/actions/returns";
import { TOKENS } from "@hullwise/ui/tokens";

type Localized = Record<string, string>;
const TEXTS = ["title", "intro", "instructions", "successMessage", "confirmText"] as const;

export function PortalConfigForm({ slug, url, config: initial, locales, defaultLocale, reasons, paymentMethods }: { slug: string; url: string; config: ReturnPortalConfig; locales: string[]; defaultLocale: string; reasons: { code: string; label: string }[]; paymentMethods: string[] }) {
  const t = useTranslations("return_portal_settings");
  const tc = useTranslations("common");
  const tr = useTranslations("returns");
  const [c, setC] = useState<ReturnPortalConfig>(initial);
  const [lang, setLang] = useState(locales.includes(defaultLocale) ? defaultLocale : locales[0]!);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const set = <K extends keyof ReturnPortalConfig>(k: K, v: ReturnPortalConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const setText = (k: (typeof TEXTS)[number], v: string) => setC((x) => ({ ...x, [k]: { ...(x[k] as Localized), [lang]: v } }));
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const setField = (i: number, patch: Partial<PortalField>) => set("fields", c.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const save = () =>
    start(async () => {
      const cleaned = { ...c, logoUrl: c.logoUrl || null, policyUrl: c.policyUrl || null, supportEmail: c.supportEmail || null };
      const r = await savePortalConfigAction(slug, cleaned);
      setResult(r.ok ? { ok: true } : { ok: false, error: r.error });
    });
  return (
    <div className="space-y-4" data-testid="portal-config-form">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("link_title")}</CardTitle>
          <CardDescription>{t("link_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={c.enabled} onChange={(e) => set("enabled", e.target.checked)} data-testid="portal-enabled" /> {t("enabled")}
          </label>
          <div className="flex gap-2">
            <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} data-testid="portal-url" />
            {c.enabled && <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-md border px-3 text-sm">{t("open")}</a>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("brand")}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pc-logo">{t("logo")}</Label>
            <Input id="pc-logo" type="url" placeholder="https://" value={c.logoUrl ?? ""} onChange={(e) => set("logoUrl", e.target.value || null)} />
            <p className="text-xs text-muted-foreground">{t("logo_branding_hint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pc-color">{t("color")}</Label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={c.primaryColor === null} onChange={(e) => set("primaryColor", e.target.checked ? null : TOKENS.light.primary)} data-testid="portal-use-branding" /> {t("use_branding")}
            </label>
            {c.primaryColor !== null && <div className="flex gap-2"><input id="pc-color" type="color" value={c.primaryColor} onChange={(e) => set("primaryColor", e.target.value)} className="h-9 w-12 rounded border" /><Input value={c.primaryColor} onChange={(e) => set("primaryColor", e.target.value)} aria-label={t("color")} /></div>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pc-support">{t("support_email")}</Label>
            <Input id="pc-support" type="email" value={c.supportEmail ?? ""} onChange={(e) => set("supportEmail", e.target.value || null)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pc-policy">{t("policy_url")}</Label>
            <Input id="pc-policy" type="url" placeholder="https://" value={c.policyUrl ?? ""} onChange={(e) => set("policyUrl", e.target.value || null)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t("texts")}</CardTitle>
            <div className="flex gap-1 rounded-md bg-muted p-1 text-xs" role="tablist">
              {locales.map((l) => <button key={l} type="button" role="tab" aria-selected={lang === l} onClick={() => setLang(l)} className={cn("rounded-sm px-2 py-1", lang === l ? "bg-card shadow-sm" : "text-muted-foreground")}>{l.toUpperCase()}</button>)}
            </div>
          </div>
          <CardDescription>{t("texts_hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {TEXTS.map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`pc-${k}-${lang}`}>{t(`text.${k}`)}</Label>
              {k === "title" ? <Input id={`pc-${k}-${lang}`} value={(c[k] as Localized)[lang] ?? ""} onChange={(e) => setText(k, e.target.value)} /> : <Textarea id={`pc-${k}-${lang}`} rows={k === "instructions" ? 4 : 2} value={(c[k] as Localized)[lang] ?? ""} onChange={(e) => setText(k, e.target.value)} />}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("rules")}</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <fieldset className="space-y-1">
            <legend className="font-medium">{t("resolutions")}</legend>
            <div className="flex flex-wrap gap-3">{(["refund", "exchange", "voucher"] as const).map((r) => <label key={r} className="flex items-center gap-1.5"><input type="checkbox" checked={c.resolutions.includes(r)} onChange={() => { const next = toggle(c.resolutions, r); if (next.length) set("resolutions", next); }} /> {tr(`resolution.${r}`)}</label>)}</div>
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="font-medium">{t("reasons")}</legend>
            <p className="text-xs text-muted-foreground">{t("reasons_hint")}</p>
            <div className="flex flex-wrap gap-3">{reasons.map((r) => <label key={r.code} className="flex items-center gap-1.5"><input type="checkbox" checked={c.reasonCodes.includes(r.code)} onChange={() => set("reasonCodes", toggle(c.reasonCodes, r.code))} /> {r.label}</label>)}</div>
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="font-medium">{t("bank_for")}</legend>
            <p className="text-xs text-muted-foreground">{t("bank_for_hint")}</p>
            <div className="flex flex-wrap gap-3">{paymentMethods.map((m) => <label key={m} className="flex items-center gap-1.5"><input type="checkbox" checked={(c.bankDetailsFor as string[]).includes(m)} onChange={() => set("bankDetailsFor", toggle(c.bankDetailsFor as string[], m) as ReturnPortalConfig["bankDetailsFor"])} /> {t(`methods.${m}`)}</label>)}</div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pc-lookup">{t("lookup_by")}</Label>
              <Select id="pc-lookup" value={c.lookupBy} onChange={(e) => set("lookupBy", e.target.value as ReturnPortalConfig["lookupBy"])}>
                <option value="email">{t("lookup.email")}</option>
                <option value="email_or_phone">{t("lookup.email_or_phone")}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pc-tracking">{t("tracking")}</Label>
              <Select id="pc-tracking" value={c.tracking.mode} onChange={(e) => set("tracking", { ...c.tracking, mode: e.target.value as "off" })}>
                {["off", "optional", "required"].map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pc-carriers">{t("carriers")}</Label>
              <Input id="pc-carriers" value={c.tracking.carriers.join(", ")} onChange={(e) => set("tracking", { ...c.tracking, carriers: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 15) })} placeholder="DHL, UPS" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pc-photos">{t("photos")}</Label>
              <Select id="pc-photos" value={c.photos.mode} onChange={(e) => set("photos", { ...c.photos, mode: e.target.value as "off" })}>
                {["off", "optional", "required"].map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pc-photos-max">{t("photos_max")}</Label>
              <Input id="pc-photos-max" type="number" min={1} max={5} value={c.photos.max} onChange={(e) => set("photos", { ...c.photos, max: Math.min(5, Math.max(1, Number(e.target.value) || 1)) })} />
            </div>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={c.trackingPage} onChange={(e) => set("trackingPage", e.target.checked)} /> {t("tracking_page")}</label>
          <div className="space-y-1.5 rounded-md border p-3">
            <label className="flex items-center gap-2"><input type="checkbox" checked={c.returnLabel.enabled} onChange={(e) => set("returnLabel", { ...c.returnLabel, enabled: e.target.checked })} data-testid="portal-label-enabled" /> {t("label_enabled")}</label>
            <Label htmlFor="pc-label-dest" className="text-xs">{t("label_destination")}</Label>
            <Textarea id="pc-label-dest" rows={3} value={c.returnLabel.destination} onChange={(e) => set("returnLabel", { ...c.returnLabel, destination: e.target.value })} />
            <p className="text-xs text-muted-foreground">{t("label_hint")}</p>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={c.askShippedFirst} onChange={(e) => set("askShippedFirst", e.target.checked)} /> {t("ask_shipped")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={c.exchangeNoteRequired} onChange={(e) => set("exchangeNoteRequired", e.target.checked)} /> {t("exchange_note")}</label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("fields")}</CardTitle>
          <CardDescription>{t("fields_hint", { lang: lang.toUpperCase() })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {c.fields.map((f, i) => (
            <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[8rem_8rem_minmax(0,1fr)_auto]" data-testid="portal-field">
              <Input aria-label={t("field_key")} value={f.key} onChange={(e) => setField(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) })} />
              <Select aria-label={t("field_type")} value={f.type} onChange={(e) => setField(i, { type: e.target.value as PortalField["type"] })}>
                {["text", "textarea", "select", "checkbox"].map((x) => <option key={x} value={x}>{t(`types.${x}`)}</option>)}
              </Select>
              <Input aria-label={t("field_label")} placeholder={t("field_label")} value={f.label[lang] ?? ""} onChange={(e) => setField(i, { label: { ...f.label, [lang]: e.target.value } })} />
              <button type="button" aria-label={tc("delete")} onClick={() => set("fields", c.fields.filter((_, j) => j !== i))} className="rounded p-2 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              {f.type === "select" && <Input className="sm:col-span-3" aria-label={t("field_options")} placeholder={t("field_options")} value={f.options.join(", ")} onChange={(e) => setField(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 30) })} />}
              <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> {t("required")}</label>
            </div>
          ))}
          {c.fields.length < 15 && <Button type="button" variant="outline" size="sm" onClick={() => set("fields", [...c.fields, { key: `field_${c.fields.length + 1}`, type: "text", label: {}, required: false, options: [], optionLabels: {} }])}><Plus className="h-4 w-4" /> {t("add_field")}</Button>}
        </CardContent>
      </Card>

      {result && <Alert variant={result.ok ? "info" : "destructive"}><AlertDescription>{result.ok ? tc("saved") : tc(`errors.${result.error}`)}</AlertDescription></Alert>}
      <Button onClick={save} disabled={pending} data-testid="portal-save">{tc("save")}</Button>
    </div>
  );
}

/** Return shipping deduction, write-back switch and order tags per status. */
export function BehaviourForm({ slug, canEdit, currency, statuses, initial }: { slug: string; canEdit: boolean; currency: string; statuses: string[]; initial: { returnShippingCostMinor: number; returnsWriteBack: boolean; returnPlatformTags: Record<string, string[]>; returnLabelCostMinor: number; returnHandlingCostMinor: number } }) {
  const t = useTranslations("return_portal_settings.behaviour");
  const tc = useTranslations("common");
  const ts = useTranslations("return_status");
  const [cost, setCost] = useState((initial.returnShippingCostMinor / 100).toFixed(2));
  const [writeBack, setWriteBack] = useState(initial.returnsWriteBack);
  const [label, setLabel] = useState((initial.returnLabelCostMinor / 100).toFixed(2));
  const [handling, setHandling] = useState((initial.returnHandlingCostMinor / 100).toFixed(2));
  const [tags, setTags] = useState<Record<string, string>>(Object.fromEntries(statuses.map((s) => [s, (initial.returnPlatformTags[s] ?? []).join(", ")])));
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const save = () =>
    start(async () => {
      const r = await saveReturnBehaviourAction(slug, { returnShippingCostMinor: Math.round(Number(cost.replace(",", ".")) * 100) || 0, returnsWriteBack: writeBack, returnLabelCostMinor: Math.round(Number(label.replace(",", ".")) * 100) || 0, returnHandlingCostMinor: Math.round(Number(handling.replace(",", ".")) * 100) || 0, returnPlatformTags: Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5)])) });
      setResult(r.ok ? { ok: true } : { ok: false, error: r.error });
    });
  return (
    <Card className="h-fit" data-testid="return-behaviour-form">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{canEdit ? t("hint") : t("read_only")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1.5">
          <Label htmlFor="rb-cost">{t("shipping_cost", { currency })}</Label>
          <Input id="rb-cost" type="number" step="0.01" min={0} value={cost} onChange={(e) => setCost(e.target.value)} disabled={!canEdit} />
          <p className="text-xs text-muted-foreground">{t("shipping_cost_hint")}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5"><Label htmlFor="rb-label">{t("label_cost", { currency })}</Label><Input id="rb-label" type="number" step="0.01" min={0} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canEdit} /></div>
          <div className="space-y-1.5"><Label htmlFor="rb-handling">{t("handling_cost", { currency })}</Label><Input id="rb-handling" type="number" step="0.01" min={0} value={handling} onChange={(e) => setHandling(e.target.value)} disabled={!canEdit} /></div>
        </div>
        <p className="text-xs text-muted-foreground">{t("costs_hint")}</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={writeBack} onChange={(e) => setWriteBack(e.target.checked)} disabled={!canEdit} /> {t("write_back")}</label>
        <p className="text-xs text-muted-foreground">{t("write_back_hint")}</p>
        <div className="space-y-2 border-t pt-3">
          <p className="font-medium">{t("tags")}</p>
          <p className="text-xs text-muted-foreground">{t("tags_hint")}</p>
          {statuses.map((s) => (
            <div key={s} className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
              <Label htmlFor={`rb-tag-${s}`} className="text-xs">{ts(s)}</Label>
              <Input id={`rb-tag-${s}`} value={tags[s] ?? ""} onChange={(e) => setTags({ ...tags, [s]: e.target.value })} disabled={!canEdit} />
            </div>
          ))}
        </div>
        {result && <Alert variant={result.ok ? "info" : "destructive"}><AlertDescription>{result.ok ? tc("saved") : tc(`errors.${result.error}`)}</AlertDescription></Alert>}
        {canEdit && <Button onClick={save} disabled={pending} className="w-full" data-testid="behaviour-save">{tc("save")}</Button>}
      </CardContent>
    </Card>
  );
}
