"use client";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, DataList, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Select } from "@hullwise/ui";
import { PAYMENT_METHODS } from "@hullwise/core";
import { deleteStateRule, saveStateRule, type PreviewRow } from "@/server/actions/state-rules";
import { StatusBadge } from "@/components/status-badge";
import { DesktopNotice } from "@/components/mobile/desktop-notice";

interface RuleRow { id: string; name: string; priority: number; resultStatus: string; isActive: boolean; conditions: Record<string, unknown> }

function conditionSummary(c: Record<string, unknown>, t: (k: string, v?: Record<string, string | number>) => string): string[] {
  const out: string[] = [];
  const arr = (k: string) => (Array.isArray(c[k]) ? (c[k] as string[]).join(", ") : null);
  if (arr("tagsAny")) out.push(t("summary.tags_any", { v: arr("tagsAny")! }));
  if (arr("tagsAll")) out.push(t("summary.tags_all", { v: arr("tagsAll")! }));
  if (arr("tagsNone")) out.push(t("summary.tags_none", { v: arr("tagsNone")! }));
  if (arr("paymentMethods")) out.push(t("summary.payment_methods", { v: arr("paymentMethods")! }));
  if (arr("paymentStatuses")) out.push(t("summary.payment_statuses", { v: arr("paymentStatuses")! }));
  if (arr("financialStatusRaw")) out.push(t("summary.financial_raw", { v: arr("financialStatusRaw")! }));
  if (arr("fulfillmentStatusRaw")) out.push(t("summary.fulfillment_raw", { v: arr("fulfillmentStatusRaw")! }));
  if (typeof c.minAgeHours === "number") out.push(t("summary.min_age", { v: c.minAgeHours }));
  if (out.length === 0) out.push(t("summary.always"));
  return out;
}

export function StateRulesEditor({ slug, statuses, rules, preview }: { slug: string; statuses: string[]; rules: RuleRow[]; preview: { rows: PreviewRow[]; changed: number } }) {
  const t = useTranslations("state_rules");
  const tc = useTranslations("common");
  const ts = useTranslations("order_status");
  const [editing, setEditing] = useState<RuleRow | null | "new">(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
      <DesktopNotice className="mb-0 xl:col-span-2" />
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>{t("rules_title")}</CardTitle>
            <CardDescription>{t("rules_description")}</CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> {t("add_rule")}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {rules.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("no_rules")}</p> : (
            <DataList
              rows={rules}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ className: r.isActive ? "" : "opacity-50", "data-testid": "state-rule-row" })}
              columns={[
                { key: "priority", header: t("priority"), headClassName: "w-16", className: "tabular", cell: (r) => r.priority },
                { key: "rule", header: t("rule"), mobile: "title", cell: (r) => <>{r.name}{!r.isActive && <Badge variant="muted" className="ml-2">{t("inactive")}</Badge>}</> },
                { key: "result", header: t("result"), mobile: "badge", cell: (r) => <StatusBadge status={r.resultStatus} /> },
                { key: "conditions", header: t("conditions"), mobile: "subtitle", className: "text-xs text-muted-foreground", cell: (r) => conditionSummary(r.conditions, t).map((x) => <span key={x} className="mb-1 mr-2 inline-block rounded bg-muted px-1.5 py-0.5">{x}</span>) },
                {
                  key: "actions",
                  header: <span className="sr-only">{tc("edit")}</span>,
                  mobile: "action",
                  className: "whitespace-nowrap md:text-right",
                  cell: (r) => (
                    <div className="flex gap-1 md:justify-end">
                      <Button variant="ghost" size="icon" aria-label={tc("edit")} onClick={() => setEditing(r)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={tc("delete")} disabled={pending} onClick={() => start(() => void deleteStateRule(slug, r.id))}>
                        <Trash2 />
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
          <div className="border-t p-4 text-xs text-muted-foreground">{t("overrides_note")}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("preview_title")}</CardTitle>
          <CardDescription>{t("preview_description", { n: preview.rows.length, changed: preview.changed })}</CardDescription>
        </CardHeader>
        <CardContent className="max-h-[32rem] overflow-y-auto p-0">
          <DataList
            rows={preview.rows}
            rowKey={(r) => r.id}
            rowProps={(r) => ({ className: r.changed ? "bg-warning/10" : "", "data-testid": "state-preview-row" })}
            columns={[
              { key: "order", header: t("order"), mobile: "title", className: "text-xs", cell: (r) => r.name },
              { key: "current", header: t("current"), label: t("current"), cell: (r) => <StatusBadge status={r.current} /> },
              { key: "next", header: t("would_be"), label: t("would_be"), cell: (r) => <><StatusBadge status={r.next} /><span className="ml-1 block text-[10px] text-muted-foreground max-md:inline">{r.reason}</span></> },
            ]}
          />
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? t("add_rule") : t("edit_rule")}</DialogTitle>
            <DialogDescription>{t("dialog_description")}</DialogDescription>
          </DialogHeader>
          {editing !== null && <RuleForm slug={slug} statuses={statuses} rule={editing === "new" ? null : editing} onDone={() => setEditing(null)} ts={ts} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RuleForm({ slug, statuses, rule, onDone, ts }: { slug: string; statuses: string[]; rule: RuleRow | null; onDone: () => void; ts: (k: string) => string }) {
  const t = useTranslations("state_rules");
  const tc = useTranslations("common");
  const tp = useTranslations("payment_methods");
  const [state, action, pending] = useActionState(async (prev: Awaited<ReturnType<typeof saveStateRule>> | null, fd: FormData) => {
    const res = await saveStateRule(slug, prev, fd);
    if (res.ok) onDone();
    return res;
  }, null);
  const c = rule?.conditions ?? {};
  const arr = (k: string) => (Array.isArray(c[k]) ? (c[k] as string[]).join(", ") : "");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      {rule && <input type="hidden" name="id" value={rule.id} />}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="rule-name">{t("rule")}</Label>
        <Input id="rule-name" name="name" defaultValue={rule?.name ?? ""} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-priority">{t("priority")}</Label>
        <Input id="rule-priority" name="priority" type="number" min={0} defaultValue={rule?.priority ?? 100} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-result">{t("result")}</Label>
        <Select id="rule-result" name="resultStatus" defaultValue={rule?.resultStatus ?? "confirmed"}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {ts(s)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-tagsAny">{t("fields.tags_any")}</Label>
        <Input id="rule-tagsAny" name="tagsAny" defaultValue={arr("tagsAny")} placeholder="vip, preorder" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-tagsNone">{t("fields.tags_none")}</Label>
        <Input id="rule-tagsNone" name="tagsNone" defaultValue={arr("tagsNone")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-tagsAll">{t("fields.tags_all")}</Label>
        <Input id="rule-tagsAll" name="tagsAll" defaultValue={arr("tagsAll")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-pm">{t("fields.payment_methods")}</Label>
        <Input id="rule-pm" name="paymentMethods" defaultValue={arr("paymentMethods")} placeholder={PAYMENT_METHODS.map((m) => tp(m)).slice(0, 2).join(", ")} list="payment-methods" />
        <datalist id="payment-methods">
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-ps">{t("fields.payment_statuses")}</Label>
        <Input id="rule-ps" name="paymentStatuses" defaultValue={arr("paymentStatuses")} placeholder="pending, paid" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-fin">{t("fields.financial_raw")}</Label>
        <Input id="rule-fin" name="financialStatusRaw" defaultValue={arr("financialStatusRaw")} placeholder="authorized, pending" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-ful">{t("fields.fulfillment_raw")}</Label>
        <Input id="rule-ful" name="fulfillmentStatusRaw" defaultValue={arr("fulfillmentStatusRaw")} placeholder="null, unfulfilled" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rule-age">{t("fields.min_age")}</Label>
        <Input id="rule-age" name="minAgeHours" type="number" min={0} defaultValue={typeof c.minAgeHours === "number" ? c.minAgeHours : ""} />
      </div>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <Checkbox name="isActive" defaultChecked={rule?.isActive ?? true} /> {t("active")}
      </label>
      {state && !state.ok && (
        <Alert variant="destructive" className="sm:col-span-2">
          <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {tc("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {tc("save")}
        </Button>
      </div>
    </form>
  );
}
