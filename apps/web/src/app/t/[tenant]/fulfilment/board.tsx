"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { FileText, PackageCheck, Truck, Undo2 } from "lucide-react";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, cn } from "@hullwise/ui";
import { formatDate, formatDateTime } from "@hullwise/core";
import { ListSelection, RowCheckbox, useSelection } from "@/components/lists/selection";
import { StatusBadge } from "@/components/status-badge";
import { bulkPackAction, setPackedAction, shipOrderAction } from "@/server/actions/fulfilment";
import type { ActionResult } from "@/server/action-result";

export interface CardData {
  id: string;
  name: string;
  customerName: string | null;
  country: string | null;
  city: string | null;
  placedAt: string;
  status: string;
  totalMinor: number;
  currency: string;
  packedAt: string | null;
  units: number;
  lines: number;
  businessDays: number;
  late: boolean;
  note: string | null;
}
export interface ShippedData {
  orderId: string;
  name: string;
  customerName: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  shippedAt: string | null;
}

interface BoardProps {
  slug: string;
  canWrite: boolean;
  locale: string;
  timezone: string;
  view: "all" | "late";
  pending: CardData[];
  packed: CardData[];
  shipped: ShippedData[];
  totals: { pending: number; packed: number; shipped: number };
}

export function Board(props: BoardProps) {
  const t = useTranslations("fulfilment");
  const ids = [...props.pending, ...props.packed].map((c) => c.id);
  // phones and tablets: one column at a time behind a segmented switch (#49); all three from lg up
  const [col, setCol] = useState<"pending" | "packed" | "shipped">("pending");
  return (
    <ListSelection ids={ids}>
      {props.canWrite && <BoardBulkBar slug={props.slug} />}
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border bg-muted p-1 lg:hidden" role="tablist" aria-label={t("tabs.label")}>
        {(["pending", "packed", "shipped"] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={col === c} onClick={() => setCol(c)} className={cn("min-h-11 truncate rounded-md px-2 text-sm font-medium text-muted-foreground", col === c && "bg-card text-foreground shadow-sm")} data-testid={`board-tab-${c}`}>
            {t(`columns.${c}`)} <span className="tabular text-xs opacity-70">{props.totals[c]}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Column title="pending" hidden={col !== "pending"} total={props.totals.pending} shown={props.pending.length} empty={props.view === "late" ? "empty_late" : "empty_pending"}>
          {props.pending.map((c) => <OrderCard key={c.id} card={c} {...props} />)}
        </Column>
        <Column title="packed" hidden={col !== "packed"} total={props.totals.packed} shown={props.packed.length} empty="empty_packed">
          {props.packed.map((c) => <OrderCard key={c.id} card={c} {...props} />)}
        </Column>
        <Column title="shipped" hidden={col !== "shipped"} total={props.totals.shipped} shown={props.shipped.length} empty="empty_shipped">
          {props.shipped.map((s) => (
            <div key={`${s.orderId}-${s.trackingNumber}`} className="rounded-md border bg-card p-3 text-sm" data-testid="shipped-card">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/t/${props.slug}/orders/${s.orderId}`} className="font-medium text-primary hover:underline">{s.name}</Link>
                <StatusBadge status={s.status} namespace="shipment_status" />
              </div>
              <p className="text-xs text-muted-foreground">{s.customerName}</p>
              <p className="mt-1 text-xs">
                {s.carrier} · {s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.trackingNumber}</a> : s.trackingNumber}
              </p>
              <p className="text-xs text-muted-foreground">{formatDateTime(s.shippedAt, props.locale, props.timezone)}</p>
            </div>
          ))}
        </Column>
      </div>
    </ListSelection>
  );
}

function Column({ title, hidden, total, shown, empty, children }: { title: "pending" | "packed" | "shipped"; hidden: boolean; total: number; shown: number; empty: string; children: React.ReactNode }) {
  const t = useTranslations("fulfilment");
  return (
    <Card data-testid={`column-${title}`} className={cn(hidden && "max-lg:hidden")}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{t(`columns.${title}`)}</CardTitle>
        <span className="text-xs text-muted-foreground tabular">{shown < total ? t("showing", { shown, total }) : total}</span>
      </CardHeader>
      <CardContent className="space-y-2">{shown === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t(empty)}</p> : children}</CardContent>
    </Card>
  );
}

function OrderCard({ card, slug, canWrite, locale, timezone }: { card: CardData } & BoardProps) {
  const t = useTranslations("fulfilment");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: card.currency }).format(card.totalMinor / 100);
  const togglePacked = () =>
    start(async () => {
      const r = await setPackedAction(slug, card.id, !card.packedAt);
      setError(r.ok ? null : r.error);
      if (r.ok) router.refresh();
    });
  return (
    <div className={cn("rounded-md border bg-card p-3 text-sm", card.late && "border-destructive/50", pending && "opacity-60")} data-testid="order-card" data-order={card.name}>
      <div className="flex items-start gap-2">
        {canWrite && <RowCheckbox id={card.id} label={card.name} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/t/${slug}/orders/${card.id}`} className="font-medium text-primary hover:underline">{card.name}</Link>
            <div className="flex items-center gap-1">
              {card.late && <Badge variant="destructive" data-testid="late-badge">{t("card.late")}</Badge>}
              <StatusBadge status={card.status} />
            </div>
          </div>
          <p className="truncate text-xs text-muted-foreground">{[card.customerName, card.city, card.country].filter(Boolean).join(" · ")}</p>
          <p className="mt-1 text-xs">{t("card.units", { units: card.units, lines: card.lines })} · {money}</p>
          <p className={cn("text-xs", card.late ? "text-destructive" : "text-muted-foreground")}>
            {formatDate(card.placedAt, locale, timezone)} · {t("card.age", { days: card.businessDays })}
          </p>
          {card.packedAt && <p className="text-xs text-muted-foreground">{t("card.packed_at", { time: formatDateTime(card.packedAt, locale, timezone) })}</p>}
          {card.note && <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">{card.note}</p>}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{t(`errors.${error}`)}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="ghost">
          <a href={`/t/${slug}/fulfilment/packing-slips?ids=${card.id}`} target="_blank" rel="noreferrer" data-testid="packing-slip">
            <FileText /> {t("actions.packing_slip")}
          </a>
        </Button>
        {canWrite && (
          <>
            <Button size="sm" variant="outline" disabled={pending} onClick={togglePacked} data-testid={card.packedAt ? "unpack" : "pack"}>
              {card.packedAt ? <Undo2 /> : <PackageCheck />} {t(card.packedAt ? "actions.unpack" : "actions.pack")}
            </Button>
            <ShipDialog slug={slug} card={card} />
          </>
        )}
      </div>
    </div>
  );
}

function ShipDialog({ slug, card }: { slug: string; card: CardData }) {
  const t = useTranslations("fulfilment");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [url, setUrl] = useState("");
  const [notify, setNotify] = useState(true);
  const [result, setResult] = useState<ActionResult<{ name: string; orderStatus: string }> | null>(null);
  const [pending, start] = useTransition();
  const fieldError = (f: string) => (result && !result.ok && result.fieldErrors?.[f] ? t(`errors.field_${result.fieldErrors[f]}`) : null);
  return (
    <>
      <Button size="sm" onClick={() => { setResult(null); setOpen(true); }} data-testid="ship">
        <Truck /> {t("actions.ship")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ship_dialog.title", { order: card.name })}</DialogTitle>
            <DialogDescription>{t("ship_dialog.description")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await shipOrderAction(slug, card.id, { carrier, trackingNumber: tracking, trackingUrl: url.trim() || null, notifyCustomer: notify });
                setResult(r);
                if (r.ok) {
                  setOpen(false);
                  router.refresh();
                }
              });
            }}
          >
            <div className="space-y-1">
              <Label htmlFor={`carrier-${card.id}`}>{t("ship_dialog.carrier")}</Label>
              <Input id={`carrier-${card.id}`} value={carrier} maxLength={60} onChange={(e) => setCarrier(e.target.value)} placeholder={t("ship_dialog.carrier_placeholder")} />
              {fieldError("carrier") && <p className="text-xs text-destructive">{fieldError("carrier")}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`tracking-${card.id}`}>{t("ship_dialog.tracking")}</Label>
              <Input id={`tracking-${card.id}`} value={tracking} maxLength={80} onChange={(e) => setTracking(e.target.value)} />
              {fieldError("trackingNumber") && <p className="text-xs text-destructive">{fieldError("trackingNumber")}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`url-${card.id}`}>{t("ship_dialog.tracking_url")}</Label>
              <Input id={`url-${card.id}`} value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
              {fieldError("trackingUrl") && <p className="text-xs text-destructive">{fieldError("trackingUrl")}</p>}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} aria-label={t("ship_dialog.notify")} />
              {t("ship_dialog.notify")}
            </label>
            {result && !result.ok && !result.fieldErrors?.carrier && !result.fieldErrors?.trackingNumber && !result.fieldErrors?.trackingUrl && (
              <Alert variant="destructive">
                <AlertDescription data-testid="ship-error">{t(`errors.${result.error}`)}{result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : ""}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("ship_dialog.cancel")}</Button>
              <Button type="submit" disabled={pending} data-testid="ship-submit">{t("ship_dialog.submit")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BoardBulkBar({ slug }: { slug: string }) {
  const t = useTranslations("fulfilment");
  const router = useRouter();
  const { selected, clear } = useSelection();
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  const ids = [...selected];
  if (!ids.length && !summary) return null;
  const run = (packed: boolean) =>
    start(async () => {
      const r = await bulkPackAction(slug, ids, packed);
      setSummary(r.ok && r.data ? t("bulk_result", { done: r.data.done, skipped: r.data.skipped, failed: r.data.failed }) : t(`errors.${r.ok ? "unknown" : r.error}`));
      clear();
      router.refresh();
    });
  return (
    <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-card p-2 text-sm shadow-sm" data-testid="board-bulk-bar">
      {ids.length > 0 && (
        <>
          <span className="font-medium">{t("selected", { count: ids.length })}</span>
          <Button asChild size="sm" variant="outline">
            <a href={`/t/${slug}/fulfilment/packing-slips?ids=${ids.join(",")}`} target="_blank" rel="noreferrer" data-testid="bulk-packing-slips">
              <FileText /> {t("actions.packing_slips", { count: ids.length })}
            </a>
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(true)} data-testid="bulk-pack">
            <PackageCheck /> {t("actions.pack_selected", { count: ids.length })}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(false)}>
            <Undo2 /> {t("actions.unpack_selected", { count: ids.length })}
          </Button>
          <Button size="sm" variant="ghost" onClick={clear}>{t("actions.clear")}</Button>
        </>
      )}
      {summary && <span className="text-muted-foreground" data-testid="bulk-summary">{summary}</span>}
    </div>
  );
}
