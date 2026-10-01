"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from "@keel/ui";
import { modifyCodOrderAction } from "@/server/actions/cod";
import type { ActionResult } from "@/server/action-result";

export interface ModifyLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
}
export interface CatalogVariant {
  id: string;
  label: string;
  priceMinor: number;
}
export interface MergeCandidate {
  id: string;
  name: string;
  total: string;
  lines: string;
}
interface AddressForm {
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  country: string;
}

/**
 * "Modify order" for a COD order still in the confirmation queue. Contact changes are edited in
 * place; line changes or merges replace the order with a new one (the old is cancelled and linked).
 */
export function ModifyOrderDialog({ slug, orderId, orderName, contact, address, note, lines, catalog, mergeCandidates, currency, locale }: { slug: string; orderId: string; orderName: string; contact: { customerName: string; phone: string; email: string }; address: AddressForm; note: string; lines: ModifyLine[]; catalog: CatalogVariant[]; mergeCandidates: MergeCandidate[]; currency: string; locale: string }) {
  const t = useTranslations("cod.modify");
  const formatMoney = useMemo(() => {
    const f = new Intl.NumberFormat(locale, { style: "currency", currency });
    return (minor: number) => f.format(minor / 100);
  }, [currency, locale]);
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [c, setC] = useState(contact);
  const [a, setA] = useState(address);
  const [n, setN] = useState("");
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(lines.map((l) => [l.id, l.quantity])));
  const [added, setAdded] = useState<{ variantId: string; quantity: number }[]>([]);
  const [pick, setPick] = useState("");
  const [merge, setMerge] = useState<string[]>([]);
  const [attemptNote, setAttemptNote] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<{ kind: string; newOrderName?: string; warning?: string | null }> | null>(null);

  const linesChanged = useMemo(() => added.length > 0 || lines.some((l) => (qty[l.id] ?? l.quantity) !== l.quantity), [added, lines, qty]);
  const willReplace = linesChanged || merge.length > 0;
  const total = lines.reduce((s, l) => s + (qty[l.id] ?? 0) * l.unitPriceMinor, 0) + added.reduce((s, x) => s + (catalog.find((v) => v.id === x.variantId)?.priceMinor ?? 0) * x.quantity, 0);
  const field = (k: keyof AddressForm, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`addr-${k}`}>{label}</Label>
      <Input id={`addr-${k}`} value={a[k]} onChange={(e) => setA({ ...a, [k]: e.target.value })} />
    </div>
  );
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="modify-order">{t("button")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("title", { order: orderName })}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <p className="font-medium">{t("contact")}</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1"><Label htmlFor="m-name">{t("customer_name")}</Label><Input id="m-name" value={c.customerName} onChange={(e) => setC({ ...c, customerName: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor="m-phone">{t("phone")}</Label><Input id="m-phone" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor="m-email">{t("email")}</Label><Input id="m-email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {field("name", t("address.name"))}
                {field("address1", t("address.address1"))}
                {field("address2", t("address.address2"))}
                {field("city", t("address.city"))}
                {field("province", t("address.province"))}
                {field("zip", t("address.zip"))}
                {field("country", t("address.country"))}
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-note">{t("note_append")}</Label>
                <Textarea id="m-note" rows={2} value={n} onChange={(e) => setN(e.target.value)} placeholder={note || undefined} />
              </div>
            </section>
            <section className="space-y-2">
              <p className="font-medium">{t("lines")}</p>
              <table className="w-full text-sm">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-b">
                      <td className="py-1 pr-2">{l.title}<span className="text-xs text-muted-foreground"> {l.variantTitle ?? ""}{l.sku ? ` · ${l.sku}` : ""}</span></td>
                      <td className="py-1 text-right tabular">{formatMoney(l.unitPriceMinor)}</td>
                      <td className="w-24 py-1 pl-2"><Input type="number" min={0} max={999} aria-label={`${t("quantity")} ${l.title}`} value={qty[l.id] ?? 0} onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Number(e.target.value) || 0) })} /></td>
                    </tr>
                  ))}
                  {added.map((x, i) => {
                    const v = catalog.find((cv) => cv.id === x.variantId);
                    return (
                      <tr key={`${x.variantId}-${i}`} className="border-b bg-muted/40">
                        <td className="py-1 pr-2">{v?.label ?? x.variantId}</td>
                        <td className="py-1 text-right tabular">{v ? formatMoney(v.priceMinor) : ""}</td>
                        <td className="w-24 py-1 pl-2"><Input type="number" min={0} max={999} value={x.quantity} onChange={(e) => setAdded(added.map((y, j) => (j === i ? { ...y, quantity: Math.max(0, Number(e.target.value) || 0) } : y)))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex gap-2">
                <Input list="cod-catalog" placeholder={t("add_product")} value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1" data-testid="add-variant" />
                <datalist id="cod-catalog">{catalog.map((v) => <option key={v.id} value={v.label} />)}</datalist>
                <Button type="button" variant="outline" disabled={!catalog.some((v) => v.label === pick)} onClick={() => { const v = catalog.find((x) => x.label === pick); if (v) { setAdded([...added, { variantId: v.id, quantity: 1 }]); setPick(""); } }}>{t("add")}</Button>
              </div>
              <p className="text-right text-xs text-muted-foreground">{t("new_total", { total: formatMoney(total) })}</p>
            </section>
            {mergeCandidates.length > 0 && (
              <section className="space-y-2">
                <p className="font-medium">{t("merge")}</p>
                <p className="text-xs text-muted-foreground">{t("merge_help")}</p>
                {mergeCandidates.map((m) => (
                  <label key={m.id} className="flex items-start gap-2">
                    <Checkbox checked={merge.includes(m.id)} onCheckedChange={(v) => setMerge(v ? [...merge, m.id] : merge.filter((x) => x !== m.id))} />
                    <span><span className="font-medium">{m.name}</span> · {m.total}<br /><span className="text-xs text-muted-foreground">{m.lines}</span></span>
                  </label>
                ))}
              </section>
            )}
            <div className="space-y-1">
              <Label htmlFor="m-attempt">{t("attempt_note")}</Label>
              <Input id="m-attempt" value={attemptNote} onChange={(e) => setAttemptNote(e.target.value)} />
            </div>
            {willReplace && <Alert><AlertDescription>{t("replace_warning")}</AlertDescription></Alert>}
            {result && !result.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${result.error}`)}</AlertDescription></Alert>}
            {result?.ok && result.data?.kind === "replaced" && <Alert><AlertDescription>{t("replaced_done", { order: result.data.newOrderName ?? "" })}{result.data.warning ? ` ${t("warning_not_cancelled")}` : ""}</AlertDescription></Alert>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              disabled={pending}
              data-testid="modify-save"
              onClick={() =>
                start(async () => {
                  const nullish = (v: string) => (v.trim() === "" ? null : v.trim());
                  const r = await modifyCodOrderAction(slug, {
                    orderId,
                    contact: { customerName: nullish(c.customerName), phone: nullish(c.phone), email: nullish(c.email), shippingAddress: { name: nullish(a.name), address1: nullish(a.address1), address2: nullish(a.address2), city: nullish(a.city), province: nullish(a.province), zip: nullish(a.zip), country: nullish(a.country), phone: nullish(c.phone) }, ...(n.trim() ? { note: n.trim(), noteMode: "append" as const } : {}) },
                    ...(willReplace ? { lines: [...lines.map((l) => ({ lineId: l.id, quantity: qty[l.id] ?? 0 })), ...added.filter((x) => x.quantity > 0).map((x) => ({ variantId: x.variantId, quantity: x.quantity }))], mergeOrderIds: merge } : {}),
                    attemptNote: nullish(attemptNote),
                  });
                  setResult(r);
                  if (r.ok) {
                    if (r.data?.kind === "replaced" && r.data.newOrderId) router.push(`/t/${slug}/orders/${r.data.newOrderId}`);
                    else {
                      setOpen(false);
                      router.refresh();
                    }
                  }
                })
              }
            >
              {willReplace ? t("save_replace") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
