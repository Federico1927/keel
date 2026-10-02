"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { BREAKDOWN_DIMENSIONS, BREAKDOWN_METRICS, DASHBOARD_PERIODS, DASHBOARD_WIDGET_CAP, SERIES_GRANULARITIES, SUPPORTED_LOCALES, TENANT_ROLES, TOP_LIST_ENTITIES, WIDGETS, newWidget, type DashboardPeriod, type DashboardWidget, type TenantRole, type WidgetType } from "@hullwise/config";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea, cn } from "@hullwise/ui";
import { discardDashboardDraftAction, saveDashboardLayoutAction } from "@/server/actions/dashboards";
import { ConfirmButton } from "@/components/confirm-button";
import { DesktopNotice } from "@/components/mobile/desktop-notice";

export interface MetricOption {
  ref: string;
  label: string;
  group: string;
  series: boolean;
}

const WIDTH: Record<number, string> = { 1: "", 2: "sm:col-span-2 lg:col-span-2", 3: "sm:col-span-2 lg:col-span-3", 4: "sm:col-span-2 lg:col-span-4" };
const GROUPS = ["metrics", "charts", "lists", "queues", "content", "hullwise"] as const;
const uid = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Layout editor of a dashboard: add widgets from the catalog, set each one's settings, size and
 * period, reorder by drag and drop (desktop) or with the arrows (any screen, the list order on phones),
 * save as a draft, preview as a role, publish, or start again from Hullwise's template.
 */
export function DashboardEditor(props: {
  slug: string;
  id: string;
  name: string;
  scope: "tenant" | "role" | "personal";
  isHome: boolean;
  roles: TenantRole[];
  period: DashboardPeriod;
  widgets: DashboardWidget[];
  hasDraft: boolean;
  availableTypes: WidgetType[];
  metrics: MetricOption[];
  template: DashboardWidget[];
  previewPath: string;
  backPath: string;
}) {
  const t = useTranslations("dashboards");
  const tr = useTranslations("roles");
  const router = useRouter();
  const [name, setName] = useState(props.name);
  const [roles, setRoles] = useState<TenantRole[]>(props.roles);
  const [period, setPeriod] = useState<DashboardPeriod>(props.period);
  const [widgets, setWidgets] = useState<DashboardWidget[]>(props.widgets);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const metricLabel = useMemo(() => new Map(props.metrics.map((m) => [m.ref, m.label])), [props.metrics]);
  const sel = widgets.find((w) => w.id === selected) ?? null;
  const panelRef = useRef<HTMLDivElement>(null);
  // below lg the settings panel sits under the widget list: bring it into view when a widget is picked (#49)
  useEffect(() => {
    if (selected && window.matchMedia("(max-width: 1023px)").matches) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  const update = (id: string, patch: Partial<DashboardWidget>) => setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const setSetting = (id: string, key: string, value: unknown) => setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, settings: { ...w.settings, [key]: value } } : w)));
  const move = (id: string, delta: number) => setWidgets((ws) => {
    const i = ws.findIndex((w) => w.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ws.length) return ws;
    const next = [...ws];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setWidgets((ws) => {
      const from = ws.findIndex((w) => w.id === dragId);
      const to = ws.findIndex((w) => w.id === targetId);
      const next = [...ws];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
    setDragId(null);
  };
  const add = (type: WidgetType) => {
    if (widgets.length >= DASHBOARD_WIDGET_CAP) return setMessage({ kind: "error", text: t("errors.too_many_widgets") });
    const w = newWidget(type, uid());
    setWidgets((ws) => [...ws, w]);
    setSelected(w.id);
  };
  const save = (publish: boolean, then?: () => void) =>
    start(async () => {
      setMessage(null);
      const r = await saveDashboardLayoutAction(props.slug, props.id, { widgets, name, roles: props.scope === "personal" ? undefined : roles, period, publish });
      if (!r.ok) return setMessage({ kind: "error", text: t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.generic") });
      setMessage({ kind: "ok", text: publish ? t("editor.published") : t("editor.saved") });
      if (then) then();
      else router.refresh();
    });

  const titleOf = (w: DashboardWidget) => {
    const s = w.settings as { title?: string; metric?: string; metrics?: string[] };
    if (s.title) return s.title;
    if (w.type === "kpi" || w.type === "target") return `${t(`widget_types.${w.type}.name`)} · ${metricLabel.get(String(s.metric)) ?? s.metric}`;
    if (w.type === "timeseries") return (s.metrics ?? []).map((m) => metricLabel.get(m) ?? m).join(" · ");
    return t(`widget_types.${w.type}.name`);
  };
  const metricSelect = (w: DashboardWidget, key: string, value: string, opts: MetricOption[], label: string, allowEmpty = false) => (
    <div className="space-y-1">
      <Label htmlFor={`${w.id}-${key}`}>{label}</Label>
      <Select id={`${w.id}-${key}`} value={value} onChange={(e) => (key.startsWith("metrics.") ? setSetting(w.id, "metrics", (() => { const list = [...((w.settings.metrics as string[]) ?? [])]; const i = Number(key.split(".")[1]); if (e.target.value) list[i] = e.target.value; else list.splice(i, 1); return list.filter(Boolean); })()) : setSetting(w.id, key, e.target.value))}>
        {allowEmpty && <option value="">{t("editor.none")}</option>}
        {[...new Set(opts.map((o) => o.group))].map((g) => (
          <optgroup key={g} label={t.has(`metric_groups.${g}`) ? t(`metric_groups.${g}`) : g}>
            {opts.filter((o) => o.group === g).map((o) => <option key={o.ref} value={o.ref}>{o.label}</option>)}
          </optgroup>
        ))}
      </Select>
    </div>
  );

  const settingsPanel = (w: DashboardWidget) => {
    const s = w.settings as Record<string, unknown>;
    const def = WIDGETS[w.type];
    const titleField = "title" in (s ?? {}) || ["kpi", "timeseries", "breakdown", "top_list", "target", "note"].includes(w.type) ? (
      <div className="space-y-1"><Label htmlFor={`${w.id}-title`}>{t("editor.title_field")}</Label><Input id={`${w.id}-title`} value={String(s.title ?? "")} maxLength={80} onChange={(e) => setSetting(w.id, "title", e.target.value || undefined)} placeholder={t("editor.title_placeholder")} /></div>
    ) : null;
    return (
      <div className="space-y-3" data-testid="widget-settings">
        <p className="text-sm font-medium">{t(`widget_types.${w.type}.name`)}</p>
        <p className="text-xs text-muted-foreground">{t(`widget_types.${w.type}.description`)}</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1"><Label htmlFor={`${w.id}-w`}>{t("editor.width")}</Label><Select id={`${w.id}-w`} value={String(w.w)} onChange={(e) => update(w.id, { w: Number(e.target.value) as DashboardWidget["w"] })}>{def.widths.map((n) => <option key={n} value={n}>{t("editor.columns", { n })}</option>)}</Select></div>
          <div className="space-y-1"><Label htmlFor={`${w.id}-h`}>{t("editor.height")}</Label><Select id={`${w.id}-h`} value={String(w.h)} onChange={(e) => update(w.id, { h: Number(e.target.value) as DashboardWidget["h"] })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t("editor.rows", { n })}</option>)}</Select></div>
        </div>
        {def.usesPeriod && (
          <div className="space-y-1"><Label htmlFor={`${w.id}-period`}>{t("editor.period")}</Label><Select id={`${w.id}-period`} value={w.period ?? ""} onChange={(e) => update(w.id, { period: (e.target.value || null) as DashboardPeriod | null })}><option value="">{t("periods.follow")}</option>{DASHBOARD_PERIODS.map((p) => <option key={p} value={p}>{t(`periods.${p}`)}</option>)}</Select></div>
        )}
        {w.type === "kpi" && (
          <>
            {metricSelect(w, "metric", String(s.metric), props.metrics, t("editor.metric"))}
            <div className="space-y-1"><Label htmlFor={`${w.id}-compare`}>{t("editor.compare")}</Label><Select id={`${w.id}-compare`} value={String(s.compare)} onChange={(e) => setSetting(w.id, "compare", e.target.value)}><option value="previous">{t("editor.compare_previous")}</option><option value="none">{t("editor.compare_none")}</option></Select></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(s.sparkline)} onChange={(e) => setSetting(w.id, "sparkline", e.target.checked)} />{t("editor.sparkline")}</label>
          </>
        )}
        {w.type === "timeseries" && (
          <>
            {[0, 1, 2].map((i) => metricSelect(w, `metrics.${i}`, ((s.metrics as string[]) ?? [])[i] ?? "", props.metrics.filter((m) => m.series), t("editor.series_n", { n: i + 1 }), i > 0))}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor={`${w.id}-chart`}>{t("editor.chart")}</Label><Select id={`${w.id}-chart`} value={String(s.chart)} onChange={(e) => setSetting(w.id, "chart", e.target.value)}><option value="line">{t("editor.chart_line")}</option><option value="bar">{t("editor.chart_bar")}</option></Select></div>
              <div className="space-y-1"><Label htmlFor={`${w.id}-granularity`}>{t("editor.granularity")}</Label><Select id={`${w.id}-granularity`} value={String(s.granularity)} onChange={(e) => setSetting(w.id, "granularity", e.target.value)}>{SERIES_GRANULARITIES.map((g) => <option key={g} value={g}>{t(`granularity.${g}`)}</option>)}</Select></div>
            </div>
          </>
        )}
        {w.type === "breakdown" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label htmlFor={`${w.id}-bm`}>{t("editor.metric")}</Label><Select id={`${w.id}-bm`} value={String(s.metric)} onChange={(e) => setSetting(w.id, "metric", e.target.value)}>{BREAKDOWN_METRICS.map((m) => <option key={m} value={m}>{metricLabel.get(m) ?? m}</option>)}</Select></div>
            <div className="space-y-1"><Label htmlFor={`${w.id}-by`}>{t("editor.by")}</Label><Select id={`${w.id}-by`} value={String(s.by)} onChange={(e) => setSetting(w.id, "by", e.target.value)}>{BREAKDOWN_DIMENSIONS.map((d) => <option key={d} value={d}>{t(`breakdown_dims.${d}`)}</option>)}</Select></div>
            <div className="space-y-1"><Label htmlFor={`${w.id}-limit`}>{t("editor.limit")}</Label><Input id={`${w.id}-limit`} type="number" min={3} max={20} value={Number(s.limit)} onChange={(e) => setSetting(w.id, "limit", Math.min(20, Math.max(3, Number(e.target.value) || 8)))} /></div>
          </div>
        )}
        {w.type === "top_list" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label htmlFor={`${w.id}-entity`}>{t("editor.entity")}</Label><Select id={`${w.id}-entity`} value={String(s.entity)} onChange={(e) => setSetting(w.id, "entity", e.target.value)}>{TOP_LIST_ENTITIES.map((x) => <option key={x} value={x}>{t(`top_entities.${x}`)}</option>)}</Select></div>
            <div className="space-y-1"><Label htmlFor={`${w.id}-tlimit`}>{t("editor.limit")}</Label><Input id={`${w.id}-tlimit`} type="number" min={3} max={20} value={Number(s.limit)} onChange={(e) => setSetting(w.id, "limit", Math.min(20, Math.max(3, Number(e.target.value) || 5)))} /></div>
          </div>
        )}
        {w.type === "target" && metricSelect(w, "metric", String(s.metric), props.metrics, t("editor.metric"))}
        {w.type === "alerts" && <div className="space-y-1"><Label htmlFor={`${w.id}-alimit`}>{t("editor.limit")}</Label><Input id={`${w.id}-alimit`} type="number" min={1} max={20} value={Number(s.limit)} onChange={(e) => setSetting(w.id, "limit", Math.min(20, Math.max(1, Number(e.target.value) || 5)))} /></div>}
        {w.type === "note" && (
          <>
            <div className="space-y-1"><Label htmlFor={`${w.id}-md`}>{t("editor.note_text")}</Label><Textarea id={`${w.id}-md`} rows={6} maxLength={4000} value={String(s.markdown ?? "")} onChange={(e) => setSetting(w.id, "markdown", e.target.value)} /><p className="text-xs text-muted-foreground">{t("editor.note_hint")}</p></div>
            {SUPPORTED_LOCALES.map((l) => (
              <div key={l} className="space-y-1"><Label htmlFor={`${w.id}-md-${l}`}>{t("editor.note_translation", { locale: l.toUpperCase() })}</Label><Textarea id={`${w.id}-md-${l}`} rows={3} maxLength={4000} value={String(((s.translations as Record<string, string>) ?? {})[l] ?? "")} onChange={(e) => setSetting(w.id, "translations", { ...((s.translations as Record<string, string>) ?? {}), [l]: e.target.value })} /></div>
            ))}
          </>
        )}
        {titleField}
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="dashboard-editor">
      <DesktopNotice className="mb-0" />
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <div className="space-y-1"><Label htmlFor="editor-name">{t("name")}</Label><Input id="editor-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="editor-period">{t("editor.dashboard_period")}</Label><Select id="editor-period" value={period} onChange={(e) => setPeriod(e.target.value as DashboardPeriod)}>{DASHBOARD_PERIODS.map((p) => <option key={p} value={p}>{t(`periods.${p}`)}</option>)}</Select></div>
          {props.scope !== "personal" && !(props.scope === "tenant" && props.isHome) && (
            <fieldset className="space-y-1 sm:col-span-2"><legend className="text-sm font-medium">{props.scope === "role" ? t("roles_variant") : t("roles_visible")}</legend>
              <div className="flex flex-wrap gap-3">{TENANT_ROLES.map((r) => <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{tr(r)}</label>)}</div>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => save(false)} data-testid="editor-save-draft">{t("editor.save_draft")}</Button>
            <Button size="sm" disabled={pending} onClick={() => save(true, () => router.push(props.backPath))} data-testid="editor-publish">{t("editor.publish")}</Button>
            <Select size="sm" aria-label={t("preview_as")} value="" wrapperClassName="w-48" data-testid="editor-preview-as" onChange={(e) => { const role = e.target.value; if (role) save(false, () => router.push(`${props.previewPath}?as=${role}&draft=1`)); }}>
              <option value="">{t("editor.preview_as")}</option>
              {TENANT_ROLES.map((r) => <option key={r} value={r}>{tr(r)}</option>)}
            </Select>
            {props.hasDraft && <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await discardDashboardDraftAction(props.slug, props.id); router.refresh(); })}>{t("editor.discard")}</Button>}
            <ConfirmButton size="sm" variant="ghost" disabled={pending} title={t("editor.reset_confirm")} confirmLabel={t("editor.reset_template")} onConfirm={() => { setWidgets(props.template.map((w) => ({ ...w, id: `${w.id}-${uid()}` }))); setSelected(null); }} data-testid="editor-reset-template">{t("editor.reset_template")}</ConfirmButton>
            <span className="text-xs text-muted-foreground">{t("editor.count", { n: widgets.length, max: DASHBOARD_WIDGET_CAP })}</span>
            {props.hasDraft && <Badge variant="warning">{t("draft_badge")}</Badge>}
            {message && <span className={cn("text-xs", message.kind === "error" ? "text-destructive" : "text-success")} role="status" data-testid="editor-message">{message.text}</span>}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <p className="mb-2 text-xs text-muted-foreground">{t("editor.drag_hint")}</p>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-flow-row-dense lg:grid-cols-4" data-testid="editor-widgets">
            {widgets.map((w, i) => (
              <li
                key={w.id}
                draggable
                onDragStart={() => setDragId(w.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropOn(w.id)}
                className={cn("min-w-0 rounded-lg border bg-card p-3 shadow-sm", WIDTH[w.w], selected === w.id && "ring-2 ring-primary", dragId === w.id && "opacity-50")}
                style={{ minHeight: `${w.h * 4.5}rem` }}
                data-testid="editor-widget"
                data-type={w.type}
              >
                <div className="flex items-start justify-between gap-1">
                  <button type="button" className="min-w-0 cursor-grab text-left text-sm font-medium" onClick={() => setSelected(w.id)} title={t("editor.configure")}>
                    <span className="mr-1 text-xs text-muted-foreground tabular">{i + 1}</span>
                    <span className="break-words">{titleOf(w)}</span>
                  </button>
                  <span className="flex shrink-0 gap-0.5">
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11" onClick={() => move(w.id, -1)} disabled={i === 0} aria-label={t("editor.move_up")}>↑</Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11" onClick={() => move(w.id, 1)} disabled={i === widgets.length - 1} aria-label={t("editor.move_down")}>↓</Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-destructive pointer-coarse:h-11 pointer-coarse:min-w-11" onClick={() => { setWidgets((ws) => ws.filter((x) => x.id !== w.id)); if (selected === w.id) setSelected(null); }} aria-label={t("editor.remove")}>✕</Button>
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t(`widget_types.${w.type}.name`)} · {t("editor.size", { w: w.w, h: w.h })}{w.period ? ` · ${t(`periods.${w.period}`)}` : ""}</p>
              </li>
            ))}
            {widgets.length === 0 && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">{t("editor.empty")}</li>}
          </ol>
        </div>
        <div className="scroll-mt-20 space-y-4" ref={panelRef}>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{sel ? t("editor.settings") : t("editor.add_widget")}</CardTitle></CardHeader>
            <CardContent>
              {sel ? (
                <div className="space-y-3">
                  {settingsPanel(sel)}
                  <Button size="sm" variant="outline" onClick={() => setSelected(null)} data-testid="editor-done">{t("editor.done")}</Button>
                </div>
              ) : (
                <div className="space-y-3" data-testid="widget-catalog">
                  {GROUPS.map((g) => {
                    const types = props.availableTypes.filter((ty) => WIDGETS[ty].group === g);
                    if (!types.length) return null;
                    return (
                      <div key={g}>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(`widget_groups.${g}`)}</p>
                        <div className="space-y-1">
                          {types.map((ty) => (
                            <button key={ty} type="button" onClick={() => add(ty)} className="flex w-full items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-muted/50" data-testid={`add-widget-${ty}`}>
                              <span><span className="font-medium">{t(`widget_types.${ty}.name`)}</span><span className="block text-xs text-muted-foreground">{t(`widget_types.${ty}.description`)}</span></span>
                              <span className="text-primary">+</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
