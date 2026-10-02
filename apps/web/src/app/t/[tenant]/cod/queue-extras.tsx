"use client";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "lucide-react";
import { Alert, AlertDescription, Button, Checkbox, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@hullwise/ui";
import { bulkQueueAction } from "@/server/actions/cod";

/** Refreshes the server-rendered queue every 30 s while visible, and when the tab regains focus (C.3). */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);
  return null;
}

export function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // clipboard unavailable (insecure context): the text stays selectable on screen
        }
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {label}
    </Button>
  );
}

/* ---------- selection and bulk bar (C.4) ---------- */

const SelectionCtx = createContext<{ selected: Set<string>; toggle: (id: string, on: boolean) => void; setAll: (ids: string[], on: boolean) => void; clear: () => void } | null>(null);

export function QueueSelection({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const setAll = (ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); for (const id of ids) if (on) n.add(id); else n.delete(id); return n; });
  return <SelectionCtx.Provider value={{ selected, toggle, setAll, clear: () => setSelected(new Set()) }}>{children}</SelectionCtx.Provider>;
}

export function SelectBox({ orderId, label }: { orderId: string; label: string }) {
  const ctx = useContext(SelectionCtx);
  if (!ctx) return null;
  return <Checkbox checked={ctx.selected.has(orderId)} onCheckedChange={(v) => ctx.toggle(orderId, v === true)} aria-label={label} className="mr-2 align-middle" data-testid="select-row" />;
}

export function SelectAll({ orderIds, label }: { orderIds: string[]; label: string }) {
  const ctx = useContext(SelectionCtx);
  if (!ctx) return null;
  const all = orderIds.length > 0 && orderIds.every((id) => ctx.selected.has(id));
  return <Checkbox checked={all} onCheckedChange={(v) => ctx.setAll(orderIds, v === true)} aria-label={label} data-testid="select-all" />;
}

export function BulkBar({ slug, operators }: { slug: string; operators: { id: string; label: string }[] }) {
  const ctx = useContext(SelectionCtx);
  const t = useTranslations("cod.bulk");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<"confirm" | "cancel" | null>(null);
  if (!ctx || ctx.selected.size === 0) return msg ? <p className="mb-3 text-sm text-muted-foreground" data-testid="bulk-result">{msg.text}</p> : null;
  const ids = [...ctx.selected];
  const run = (kind: "assign" | "unassign" | "distribute" | "confirm" | "cancel", userId?: string) =>
    start(async () => {
      const r = await bulkQueueAction(slug, { kind, orderIds: ids, userId });
      setConfirming(null);
      if (r.ok && r.data) {
        setMsg({ ok: true, text: t("result", { done: r.data.done, failed: r.data.failed }) });
        ctx.clear();
        router.refresh();
      } else setMsg({ ok: false, text: !r.ok && tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : t("failed") });
    });
  return (
    <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-card p-2 text-sm shadow-sm" data-testid="bulk-bar">
      <span className="font-medium">{t("selected", { n: ids.length })}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={pending} data-testid="bulk-assign">{t("assign")}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("assign_to")}</DropdownMenuLabel>
          {operators.map((o) => <DropdownMenuItem key={o.id} onSelect={() => run("assign", o.id)} data-testid="bulk-assign-option">{o.label}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => run("unassign")}>{t("unassign")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run("distribute")} data-testid="bulk-distribute">{t("distribute")}</Button>
      {confirming ? (
        <span className="flex items-center gap-1">
          <span>{t(confirming === "confirm" ? "confirm_question" : "cancel_question", { n: ids.length })}</span>
          <Button size="sm" variant={confirming === "cancel" ? "destructive" : "default"} disabled={pending} onClick={() => run(confirming)} data-testid="bulk-confirm-yes">{t("yes")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{tc("cancel")}</Button>
        </span>
      ) : (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirming("confirm")} data-testid="bulk-confirm">{t("confirm")}</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirming("cancel")} data-testid="bulk-cancel">{t("cancel")}</Button>
        </>
      )}
      <Button size="sm" variant="ghost" onClick={() => ctx.clear()}>{t("clear")}</Button>
      {msg && !msg.ok && <Alert variant="destructive" className="w-full py-2"><AlertDescription>{msg.text}</AlertDescription></Alert>}
    </div>
  );
}
