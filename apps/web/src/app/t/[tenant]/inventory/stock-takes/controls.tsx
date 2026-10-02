"use client";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, Button, Input, Label, Select } from "@keel/ui";
import { applyStockTakeAction, cancelStockTakeAction, createStockTakeAction, scanStockTakeAction, setStockTakeCountAction } from "@/server/actions/inventory-control";

/** New session: a location and an optional note; opens the session once created. */
export function NewStockTakeForm({ slug, locations }: { slug: string; locations: { id: string; name: string }[] }) {
  const t = useTranslations("inventory_control.stock_takes");
  const router = useRouter();
  const [state, action, pending] = useActionState(createStockTakeAction.bind(null, slug), null);
  useEffect(() => {
    if (state?.ok && state.data) router.push(`/t/${slug}/inventory/stock-takes/${state.data.id}`);
  }, [state, router, slug]);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid="new-stock-take">
      <div className="space-y-1">
        <Label htmlFor="st-location" className="text-xs">{t("location")}</Label>
        <Select id="st-location" name="locationId" size="sm" className="w-48">
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="st-note" className="text-xs">{t("note")}</Label>
        <Input id="st-note" name="note" size="sm" maxLength={500} className="w-48" />
      </div>
      <Button type="submit" size="sm" disabled={pending} data-testid="create-stock-take">
        <Plus className="h-4 w-4" /> {t("new")}
      </Button>
    </form>
  );
}

/**
 * Scanner: a barcode scanner types the code and Enter, which counts one unit; a quantity typed
 * before Enter counts that many, or replaces the count with "set". The field is cleared at once and
 * keeps the focus; scans are sent one after the other, so fast scanning never drops a code.
 */
export function StockTakeScanner({ slug, stockTakeId }: { slug: string; stockTakeId: string }) {
  const t = useTranslations("inventory_control.stock_takes");
  const te = useTranslations("inventory_control.errors");
  const router = useRouter();
  const code = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [qty, setQty] = useState("1");
  const [mode, setMode] = useState<"add" | "set">("add");
  const [, startRefresh] = useTransition();
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.current?.value.trim() ?? "";
    if (!value) return;
    const input = { code: value, quantity: Number(qty) || 0, mode };
    if (code.current) code.current.value = "";
    setQty("1");
    setMode("add");
    code.current?.focus();
    queue.current = queue.current.then(async () => {
      const r = await scanStockTakeAction(slug, stockTakeId, input);
      if (r.ok && r.data) setLast({ ok: r.data.kind === "matched", text: r.data.kind === "matched" ? t("scan_matched", { label: r.data.label, n: r.data.counted }) : t("scan_unknown", { code: r.data.code, n: r.data.counted }) });
      else if (!r.ok) setLast({ ok: false, text: te(r.fieldErrors?.reason ?? r.error) });
      startRefresh(() => router.refresh());
    }, () => undefined);
  };
  return (
    <form onSubmit={submit} className="space-y-2" data-testid="stock-take-scanner">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="scan-code">{t("scan_label")}</Label>
          <Input id="scan-code" ref={code} autoFocus autoComplete="off" placeholder={t("scan_placeholder")} data-testid="scan-code" />
        </div>
        <div className="w-24 space-y-1">
          <Label htmlFor="scan-qty">{t("quantity")}</Label>
          <Input id="scan-qty" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} data-testid="scan-qty" />
        </div>
        <div className="w-32 space-y-1">
          <Label htmlFor="scan-mode">{t("mode")}</Label>
          <Select id="scan-mode" value={mode} onChange={(e) => setMode(e.target.value as "add" | "set")} data-testid="scan-mode">
            <option value="add">{t("mode_add")}</option>
            <option value="set">{t("mode_set")}</option>
          </Select>
        </div>
        <Button type="submit" data-testid="scan-submit">{t("count")}</Button>
      </div>
      {last && <p className={last.ok ? "text-sm text-success" : "text-sm text-warning"} data-testid="scan-result" role="status">{last.text}</p>}
    </form>
  );
}

/** Inline correction of a counted quantity, or removal of the line. */
export function CountEditor({ slug, stockTakeId, countId, counted }: { slug: string; stockTakeId: string; countId: string; counted: number }) {
  const t = useTranslations("inventory_control.stock_takes");
  const router = useRouter();
  const [value, setValue] = useState(String(counted));
  const [pending, start] = useTransition();
  const save = (n: number | null) => start(async () => {
    await setStockTakeCountAction(slug, stockTakeId, countId, n);
    router.refresh();
  });
  return (
    <div className="flex items-center justify-end gap-1">
      <Input size="sm" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => Number(value) !== counted && value !== "" && save(Math.max(0, Math.trunc(Number(value))))} className="w-20 text-right" aria-label={t("columns.counted")} disabled={pending} />
      <button type="button" className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => save(null)} aria-label={t("remove_line")} disabled={pending}>
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Apply (one batch of count corrections) or cancel the session. */
export function StockTakeActions({ slug, stockTakeId, differences }: { slug: string; stockTakeId: string; differences: number }) {
  const t = useTranslations("inventory_control.stock_takes");
  const te = useTranslations("inventory_control.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={pending}
        data-testid="apply-stock-take"
        onClick={() => {
          if (!window.confirm(t("apply_confirm", { n: differences }))) return;
          start(async () => {
            const r = await applyStockTakeAction(slug, stockTakeId);
            setResult(r.ok ? { ok: true, text: t("applied", { n: r.data?.movements ?? 0, released: r.data?.released ?? 0 }) } : { ok: false, text: te(r.fieldErrors?.reason ?? r.error) });
            router.refresh();
          });
        }}
      >
        {t("apply", { n: differences })}
      </Button>
      <Button
        variant="outline"
        disabled={pending}
        data-testid="cancel-stock-take"
        onClick={() => {
          if (!window.confirm(t("cancel_confirm"))) return;
          start(async () => {
            const r = await cancelStockTakeAction(slug, stockTakeId);
            if (!r.ok) setResult({ ok: false, text: te(r.fieldErrors?.reason ?? r.error) });
            router.refresh();
          });
        }}
      >
        {t("cancel")}
      </Button>
      {result && (result.ok ? <span className="text-sm text-success" data-testid="stock-take-result">{result.text}</span> : <Alert variant="destructive"><AlertDescription>{result.text}</AlertDescription></Alert>)}
    </div>
  );
}
