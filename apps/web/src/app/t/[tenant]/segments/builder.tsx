"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { MAX_SEGMENT_CONDITIONS, MAX_SEGMENT_DEPTH } from "@keel/config";
import { OPS_BY_TYPE, SEGMENT_FIELDS, countLeaves, depthOf, formatMoney, formatNumber, isGroup, validateSegmentRules, type SegmentGroup, type SegmentLeaf, type SegmentNode, type SegmentOp } from "@keel/core";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Textarea, cn } from "@keel/ui";
import type { SegmentPreview } from "@keel/services";
import { previewSegmentAction, saveSegmentAction } from "@/server/actions/segments";

export interface BuilderOptions {
  countries: string[];
  productTypes: string[];
  tags: string[];
  products: { id: string; title: string }[];
  paymentMethods: string[];
}
export interface BuilderSegment {
  id?: string;
  name: string;
  description: string | null;
  rules: SegmentGroup;
  holdoutPercentage: number;
}

const FIELD_ORDER = Object.keys(SEGMENT_FIELDS);
const defaultLeaf = (): SegmentLeaf => ({ field: "orders_count", op: "gte", value: 2 });

function defaultValue(field: string, op: SegmentOp): unknown {
  const def = SEGMENT_FIELDS[field]!;
  if (op === "is_null" || op === "not_null") return undefined;
  if (op === "between") return [0, 100];
  switch (def.type) {
    case "number":
    case "days":
      return 1;
    case "boolean":
      return true;
    default:
      return [];
  }
}

export function SegmentBuilder({ slug, segment, options, currency, locale, canWrite, holdoutEnabled }: { slug: string; segment: BuilderSegment; options: BuilderOptions; currency: string; locale: string; canWrite: boolean; holdoutEnabled: boolean }) {
  const t = useTranslations("segment_builder");
  const tc = useTranslations("common");
  const router = useRouter();
  const [name, setName] = useState(segment.name);
  const [description, setDescription] = useState(segment.description ?? "");
  const [holdout, setHoldout] = useState(segment.holdoutPercentage);
  const [rules, setRules] = useState<SegmentGroup>(segment.rules);
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validation = useMemo(() => validateSegmentRules(rules), [rules]);
  const leaves = countLeaves(rules);
  const depth = depthOf(rules);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!validation.rules) return;
    const current = rules;
    timer.current = setTimeout(async () => {
      const r = await previewSegmentAction(slug, current);
      if (r.ok && r.data) {
        setPreview(r.data);
        setPreviewError(null);
      } else if (!r.ok) setPreviewError(r.error);
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [rules, slug, validation.rules]);

  const save = () =>
    startSave(async () => {
      const r = await saveSegmentAction(slug, { name, description: description || null, rules, holdoutPercentage: holdout }, segment.id);
      if (!r.ok) return setSaveError(r.error);
      setSaveError(null);
      router.push(`/t/${slug}/segments/${r.data!.id}`);
      router.refresh();
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <Card>
          <CardContent className={cn("grid gap-3 pt-6", holdoutEnabled && "sm:grid-cols-[1fr_8rem]")}>
            <div className="space-y-1">
              <Label htmlFor="seg-name">{t("name")}</Label>
              <Input id="seg-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} maxLength={120} />
            </div>
            {holdoutEnabled && (
              <div className="space-y-1">
                <Label htmlFor="seg-holdout">{t("holdout")}</Label>
                <Input id="seg-holdout" type="number" min={0} max={50} value={holdout} onChange={(e) => setHoldout(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} disabled={!canWrite} />
              </div>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="seg-desc">{t("description")}</Label>
              <Textarea id="seg-desc" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canWrite} rows={2} maxLength={500} />
            </div>
            {holdoutEnabled && <p className="text-xs text-muted-foreground sm:col-span-2">{t("holdout_help")}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{t("rules")}</CardTitle>
              <CardDescription>{t("limits", { leaves, maxLeaves: MAX_SEGMENT_CONDITIONS, depth, maxDepth: MAX_SEGMENT_DEPTH })}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <GroupEditor node={rules} depth={1} options={options} currency={currency} disabled={!canWrite} onChange={(g) => setRules(g)} onRemove={null} />
            {validation.errors.length > 0 && (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription>{validation.errors.map((e) => t(`errors.${e.code}`)).filter((v, i, a) => a.indexOf(v) === i).join(" ")}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
        {canWrite && (
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving || !name.trim() || !validation.rules}>{segment.id ? tc("save") : t("create")}</Button>
            {saveError && <span className="text-sm text-destructive">{tc.has(`errors.${saveError}`) ? tc(`errors.${saveError}`) : t(`errors.${saveError}`)}</span>}
          </div>
        )}
      </div>
      <Card className="h-fit lg:sticky lg:top-4" data-testid="segment-preview">
        <CardHeader>
          <CardTitle className="text-base">{t("preview")}</CardTitle>
          <CardDescription>{t("preview_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {previewError && <p className="text-sm text-destructive">{t(`errors.${previewError}`)}</p>}
          {!preview && !previewError && <p className="text-sm text-muted-foreground">{tc("loading")}</p>}
          {preview && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{t("matching")}</div>
                  <div className="text-2xl font-semibold tabular" data-testid="preview-count">{formatNumber(preview.count, locale)}</div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{t("contactable")}</div>
                  <div className="text-2xl font-semibold tabular">{formatNumber(preview.contactable, locale)}</div>
                </div>
              </div>
              {holdoutEnabled && holdout > 0 && <p className="text-xs text-muted-foreground">{t("holdout_estimate", { n: formatNumber(Math.round((preview.count * holdout) / 100), locale), pct: holdout })}</p>}
              <ul className="divide-y text-sm">
                {preview.sample.slice(0, 8).map((s) => (
                  <li key={s.customerId} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular">{s.ordersCount} · {formatMoney(s.totalSpentMinor, currency, locale)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function GroupEditor({ node, depth, options, currency, disabled, onChange, onRemove }: { node: SegmentGroup; depth: number; options: BuilderOptions; currency: string; disabled: boolean; onChange: (g: SegmentGroup) => void; onRemove: (() => void) | null }) {
  const t = useTranslations("segment_builder");
  const update = (i: number, child: SegmentNode) => onChange({ ...node, conditions: node.conditions.map((c, j) => (j === i ? child : c)) });
  const remove = (i: number) => onChange({ ...node, conditions: node.conditions.filter((_, j) => j !== i) });
  return (
    <div className={cn("rounded-lg border p-3", depth > 1 && "bg-muted/30")} data-testid="rule-group">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span>{t("match_prefix")}</span>
        <Select value={node.match} onChange={(e) => onChange({ ...node, match: e.target.value as "all" | "any" })} disabled={disabled} className="h-8 w-28" aria-label={t("match_label")}>
          <option value="all">{t("match.all")}</option>
          <option value="any">{t("match.any")}</option>
        </Select>
        <span>{t("match_suffix")}</span>
        <span className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...node, conditions: [...node.conditions, defaultLeaf()] })}>
            <Plus /> {t("add_condition")}
          </Button>
          {depth < MAX_SEGMENT_DEPTH && (
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...node, conditions: [...node.conditions, { match: "any", conditions: [defaultLeaf()] }] })}>
              <Plus /> {t("add_group")}
            </Button>
          )}
          {onRemove && (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove} aria-label={t("remove_group")}>
              <Trash2 />
            </Button>
          )}
        </span>
      </div>
      <div className="space-y-2">
        {node.conditions.length === 0 && <p className="text-xs text-destructive">{t("errors.empty_group")}</p>}
        {node.conditions.map((c, i) =>
          isGroup(c) ? (
            <GroupEditor key={i} node={c} depth={depth + 1} options={options} currency={currency} disabled={disabled} onChange={(g) => update(i, g)} onRemove={() => remove(i)} />
          ) : (
            <LeafEditor key={i} leaf={c} options={options} currency={currency} disabled={disabled} onChange={(l) => update(i, l)} onRemove={() => remove(i)} />
          ),
        )}
      </div>
    </div>
  );
}

function LeafEditor({ leaf, options, currency, disabled, onChange, onRemove }: { leaf: SegmentLeaf; options: BuilderOptions; currency: string; disabled: boolean; onChange: (l: SegmentLeaf) => void; onRemove: () => void }) {
  const t = useTranslations("segment_builder");
  const def = SEGMENT_FIELDS[leaf.field] ?? SEGMENT_FIELDS.orders_count!;
  const ops = OPS_BY_TYPE[def.type];
  const setField = (field: string) => {
    const d = SEGMENT_FIELDS[field]!;
    const op = OPS_BY_TYPE[d.type][0]!;
    onChange({ field, op, value: defaultValue(field, op) });
  };
  const setOp = (op: SegmentOp) => onChange({ ...leaf, op, value: op === "between" || op === "is_null" || op === "not_null" || leaf.op === "between" || leaf.op === "is_null" || leaf.op === "not_null" ? defaultValue(leaf.field, op) : leaf.value });
  const grouped = FIELD_ORDER.reduce<Record<string, string[]>>((acc, f) => ((acc[SEGMENT_FIELDS[f]!.group] ??= []).push(f), acc), {});
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2" data-testid="rule-leaf">
      <Select value={leaf.field} onChange={(e) => setField(e.target.value)} disabled={disabled} className="h-8 w-52" aria-label={t("field")}>
        {Object.entries(grouped).map(([g, fields]) => (
          <optgroup key={g} label={t(`groups.${g}`)}>
            {fields.map((f) => (
              <option key={f} value={f}>{t(`fields.${f}`)}</option>
            ))}
          </optgroup>
        ))}
      </Select>
      <Select value={leaf.op} onChange={(e) => setOp(e.target.value as SegmentOp)} disabled={disabled} className="h-8 w-40" aria-label={t("operator")}>
        {ops.map((o) => (
          <option key={o} value={o}>{t(`ops.${o}`)}</option>
        ))}
      </Select>
      <ValueEditor leaf={leaf} options={options} currency={currency} disabled={disabled} onChange={(value) => onChange({ ...leaf, value })} />
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove} aria-label={t("remove_condition")} className="ml-auto">
        <X />
      </Button>
    </div>
  );
}

function ValueEditor({ leaf, options, currency, disabled, onChange }: { leaf: SegmentLeaf; options: BuilderOptions; currency: string; disabled: boolean; onChange: (v: unknown) => void }) {
  const t = useTranslations("segment_builder");
  const tr = useTranslations("rfm");
  const tp = useTranslations("payment_methods");
  const tpr = useTranslations("predictions");
  const def = SEGMENT_FIELDS[leaf.field]!;
  if (leaf.op === "is_null" || leaf.op === "not_null") return null;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const scale = def.money ? 100 : 1;
  if (leaf.op === "between") {
    const [a, b] = Array.isArray(leaf.value) ? (leaf.value as number[]) : [0, 0];
    return (
      <span className="flex items-center gap-1">
        <Input type="number" className="h-8 w-24" value={num(a) / scale} onChange={(e) => onChange([Math.round(Number(e.target.value) * scale), b])} disabled={disabled} aria-label={t("from")} />
        <span className="text-xs">–</span>
        <Input type="number" className="h-8 w-24" value={num(b) / scale} onChange={(e) => onChange([a, Math.round(Number(e.target.value) * scale)])} disabled={disabled} aria-label={t("to")} />
        {def.money && <span className="text-xs text-muted-foreground">{currency}</span>}
      </span>
    );
  }
  if (def.type === "number" || def.type === "days") {
    return (
      <span className="flex items-center gap-1">
        <Input type="number" className="h-8 w-28" value={num(leaf.value) / scale} onChange={(e) => onChange(Math.round(Number(e.target.value) * scale))} disabled={disabled} aria-label={t("value")} />
        <span className="text-xs text-muted-foreground">{def.money ? currency : def.type === "days" ? t("days") : ""}</span>
      </span>
    );
  }
  if (def.type === "boolean") {
    return (
      <Select value={leaf.value === false ? "false" : "true"} onChange={(e) => onChange(e.target.value === "true")} disabled={disabled} className="h-8 w-28" aria-label={t("value")}>
        <option value="true">{t("true")}</option>
        <option value="false">{t("false")}</option>
      </Select>
    );
  }
  // enum / arrays: multi-pick
  const pick: { value: string; label: string }[] = (() => {
    switch (leaf.field) {
      case "country": return options.countries.map((v) => ({ value: v, label: v }));
      case "tags": return options.tags.map((v) => ({ value: v, label: v }));
      case "payment_methods": return options.paymentMethods.map((v) => ({ value: v, label: tp.has(v) ? tp(v) : v }));
      case "bought_product": return options.products.map((p) => ({ value: p.id, label: p.title }));
      case "bought_product_type": return options.productTypes.map((v) => ({ value: v, label: v }));
      case "rfm_recency": return (def.values as readonly string[]).map((v) => ({ value: v, label: tr(`recency.${v}`) }));
      case "rfm_frequency": return (def.values as readonly string[]).map((v) => ({ value: v, label: tr(`frequency.${v}`) }));
      case "rfm_tier": return (def.values as readonly string[]).map((v) => ({ value: v, label: tr(`tier.${v}`) }));
      case "churn_risk": return (def.values as readonly string[]).map((v) => ({ value: v, label: tpr(`risk.${v}`) }));
      default: return [];
    }
  })();
  const selected = Array.isArray(leaf.value) ? (leaf.value as string[]) : [];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {selected.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
          {pick.find((p) => p.value === v)?.label ?? v}
          {!disabled && (
            <button type="button" onClick={() => onChange(selected.filter((x) => x !== v))} aria-label={t("remove_value")} className="opacity-60 hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <Select value="" onChange={(e) => e.target.value && !selected.includes(e.target.value) && onChange([...selected, e.target.value])} disabled={disabled} className="h-8 w-44" aria-label={t("add_value")}>
        <option value="">{t("add_value")}</option>
        {pick.filter((p) => !selected.includes(p.value)).map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </Select>
      {selected.length === 0 && <span className="text-xs text-destructive">{t("errors.bad_value")}</span>}
    </span>
  );
}
