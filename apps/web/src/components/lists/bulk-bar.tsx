"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Alert, AlertDescription, Badge, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select } from "@keel/ui";
import { ORDER_STATUSES, parseAmountToMinor } from "@keel/core";
import type { BatchSummary } from "@keel/services";
import { bulkOrdersAction, bulkProductsAction, bulkReturnsAction } from "@/server/actions/lists";
import type { ActionResult } from "@/server/action-result";
import { useSelection } from "./selection";

type BulkListKey = "orders" | "products" | "returns";
const MANUAL_STATUSES = ORDER_STATUSES.filter((s) => !["cancelled", "returned", "returned_partial", "refunded", "delivered"].includes(s));
const splitTags = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Bar shown while rows are selected: the bulk actions the role may run on this list (computed on the
 * server), a dialog for each action's parameters, and the summary of the run (done / skipped with
 * reason / failed with error). Writes go through the same services as single-record actions.
 */
export function BulkBar({ slug, list, actions, members = [], locations = [] }: { slug: string; list: BulkListKey; actions: string[]; members?: { id: string; name: string }[]; locations?: { id: string; name: string }[] }) {
  const t = useTranslations("lists");
  const tc = useTranslations("common");
  const ts = useTranslations("order_status");
  const tps = useTranslations("products");
  const tcr = useTranslations("order_detail");
  const router = useRouter();
  const { selected, clear } = useSelection();
  const [pending, start] = useTransition();
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  // parameters of the open dialog
  const [status, setStatus] = useState<string>(list === "products" ? "draft" : "on_hold");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("customer");
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(true);
  const [assignee, setAssignee] = useState("");
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");
  const [mode, setMode] = useState("set");
  const [value, setValue] = useState("");
  const [location, setLocation] = useState("");

  if (!actions.length || (selected.size === 0 && !summary)) return null;
  const ids = [...selected];

  const input = (): unknown | null => {
    if (list === "orders") {
      if (action === "status") return { action, status, note: note || null };
      if (action === "cancel") return { action, reason, restock, refund };
      if (action === "assign") return { action, userId: assignee || null };
      if (action === "tag") return { action, add: splitTags(add), remove: splitTags(remove) };
    }
    if (list === "products") {
      if (action === "status") return { action, status };
      if (action === "tags") return { action, add: splitTags(add), remove: splitTags(remove) };
      if (action === "price") {
        if (mode === "percent") {
          const pct = Number(value.replace(",", "."));
          return Number.isFinite(pct) && value.trim() ? { action, price: { mode, bps: Math.round(pct * 100) } } : null;
        }
        const minor = parseAmountToMinor(value);
        return minor === null ? null : { action, price: { mode: "set", valueMinor: minor } };
      }
      if (action === "compare_at") {
        if (mode === "clear") return { action, compareAt: { mode } };
        const minor = parseAmountToMinor(value);
        return minor === null ? null : { action, compareAt: { mode: "set", valueMinor: minor } };
      }
    }
    if (list === "returns") return action === "receive" ? { action, restockLocationId: location || null, note: note || null } : { action, note: note || null };
    return null;
  };

  const submit = () => {
    const payload = input();
    if (!payload) return setError(tc("errors.invalid_input"));
    start(async () => {
      const fn = list === "orders" ? bulkOrdersAction : list === "products" ? bulkProductsAction : bulkReturnsAction;
      const r: ActionResult<BatchSummary> = await fn(slug, ids, payload);
      if (!r.ok) return setError(tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : r.error);
      setError(null);
      setAction(null);
      setSummary(r.data ?? null);
      router.refresh();
    });
  };
  const open = (a: string) => {
    setError(null);
    setMode(a === "compare_at" && mode === "percent" ? "set" : mode);
    setAction(a);
  };
  const reasonText = (r: string | null) => {
    if (!r) return "";
    const [code, detail] = [r.split(":")[0]!, r.split(":").slice(1).join(":").trim()];
    return t.has(`reasons.${code}`) ? t(`reasons.${code}`, { detail }) : r;
  };
  const tagFields = (
    <>
      <div className="space-y-1.5"><Label htmlFor="bulk-add">{t("params.add_tags")}</Label><Input id="bulk-add" value={add} onChange={(e) => setAdd(e.target.value)} placeholder={t("params.tags_placeholder")} /></div>
      <div className="space-y-1.5"><Label htmlFor="bulk-remove">{t("params.remove_tags")}</Label><Input id="bulk-remove" value={remove} onChange={(e) => setRemove(e.target.value)} placeholder={t("params.tags_placeholder")} /></div>
    </>
  );

  return (
    <>
      {selected.size > 0 && (
        <div className="sticky bottom-3 z-30 mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 shadow-lg" data-testid="bulk-bar">
          <span className="px-2 text-sm font-medium" data-testid="bulk-count">{t("selected", { count: selected.size })}</span>
          {actions.map((a) => (
            <Button key={a} size="sm" variant={a === "cancel" || a === "reject" ? "destructive" : "outline"} disabled={pending} onClick={() => open(a)} data-testid={`bulk-${a}`}>
              {t(`actions.${list}.${a}`)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={clear} aria-label={t("clear_selection")}><X /></Button>
        </div>
      )}

      <Dialog open={action !== null} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action ? t(`actions.${list}.${action}`) : ""}</DialogTitle>
            <DialogDescription>{t("dialog_description", { count: ids.length })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {list === "orders" && action === "status" && (
              <>
                <div className="space-y-1.5"><Label htmlFor="bulk-status">{t("params.status")}</Label><Select id="bulk-status" value={status} onChange={(e) => setStatus(e.target.value)}>{MANUAL_STATUSES.map((s) => <option key={s} value={s}>{ts(s)}</option>)}</Select></div>
                <div className="space-y-1.5"><Label htmlFor="bulk-note">{t("params.note")}</Label><Input id="bulk-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
              </>
            )}
            {list === "orders" && action === "cancel" && (
              <>
                <p className="text-sm text-muted-foreground">{tcr("cancel_dialog_description")}</p>
                <div className="space-y-1.5"><Label htmlFor="bulk-reason">{tcr("cancel_reason")}</Label><Select id="bulk-reason" value={reason} onChange={(e) => setReason(e.target.value)}>{["customer", "inventory", "fraud", "declined", "other"].map((r) => <option key={r} value={r}>{tcr(`cancel_reasons.${r}`)}</option>)}</Select></div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={restock} onCheckedChange={(v) => setRestock(Boolean(v))} /> {tcr("restock")}</label>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={refund} onCheckedChange={(v) => setRefund(Boolean(v))} /> {tcr("refund")}</label>
              </>
            )}
            {list === "orders" && action === "assign" && (
              <div className="space-y-1.5"><Label htmlFor="bulk-assignee">{t("params.assignee")}</Label><Select id="bulk-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">{tcr("unassigned")}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></div>
            )}
            {((list === "orders" && action === "tag") || (list === "products" && action === "tags")) && tagFields}
            {list === "products" && action === "status" && (
              <div className="space-y-1.5"><Label htmlFor="bulk-pstatus">{t("params.status")}</Label><Select id="bulk-pstatus" value={status} onChange={(e) => setStatus(e.target.value)}>{["active", "draft", "archived"].map((s) => <option key={s} value={s}>{tps(`status.${s}`)}</option>)}</Select></div>
            )}
            {list === "products" && (action === "price" || action === "compare_at") && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="bulk-mode">{t("params.mode")}</Label>
                  <Select id="bulk-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="set">{t("params.mode_set")}</option>
                    {action === "price" ? <option value="percent">{t("params.mode_percent")}</option> : <option value="clear">{t("params.mode_clear")}</option>}
                  </Select>
                </div>
                {mode !== "clear" && <div className="space-y-1.5"><Label htmlFor="bulk-value">{mode === "percent" ? t("params.percent") : t("params.amount")}</Label><Input id="bulk-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === "percent" ? "-10" : "49.90"} /></div>}
                <p className="text-xs text-muted-foreground">{t("params.all_variants")}</p>
              </>
            )}
            {list === "returns" && action === "receive" && (
              <div className="space-y-1.5"><Label htmlFor="bulk-location">{t("params.restock_location")}</Label><Select id="bulk-location" value={location} onChange={(e) => setLocation(e.target.value)}><option value="">{t("params.no_restock")}</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>
            )}
            {list === "returns" && (
              <>
                {action === "refund" && <p className="text-sm text-muted-foreground">{t("params.refund_hint")}</p>}
                <div className="space-y-1.5"><Label htmlFor="bulk-rnote">{t("params.note")}</Label><Input id="bulk-rnote" value={note} onChange={(e) => setNote(e.target.value)} /></div>
              </>
            )}
            <p className="text-xs text-muted-foreground">{t("concurrency_hint")}</p>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>{tc("cancel")}</Button>
            <Button variant={action === "cancel" || action === "reject" ? "destructive" : "default"} disabled={pending} onClick={submit} data-testid="bulk-confirm">{pending ? tc("loading") : t("run", { count: ids.length })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={summary !== null} onOpenChange={(o) => { if (!o) { setSummary(null); clear(); } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("summary.title")}</DialogTitle>
            <DialogDescription data-testid="bulk-summary">{summary ? t("summary.counts", { done: summary.done, skipped: summary.skipped, failed: summary.failed }) : ""}</DialogDescription>
          </DialogHeader>
          {summary && summary.items.some((i) => i.status !== "done" || i.note) && (
            <ul className="divide-y rounded-md border text-sm">
              {summary.items.filter((i) => i.status !== "done" || i.note).map((i) => (
                <li key={i.id} className="flex flex-wrap items-start gap-2 p-2" data-testid="bulk-item" data-status={i.status}>
                  <span className="font-medium">{i.label ?? i.id.slice(0, 8)}</span>
                  <Badge variant={i.status === "failed" ? "destructive" : i.status === "skipped" ? "warning" : "muted"}>{t(`summary.${i.status}`)}</Badge>
                  <span className="w-full text-xs text-muted-foreground sm:w-auto">{reasonText(i.reason ?? i.note ?? null)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{summary ? t("summary.batch", { id: summary.batchId.slice(0, 8) }) : ""}</p>
          <DialogFooter>
            <Button onClick={() => { setSummary(null); clear(); }}>{t("summary.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
