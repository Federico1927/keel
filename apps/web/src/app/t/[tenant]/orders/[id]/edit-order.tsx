"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@keel/ui";
import { editOrderAction, suggestAddressesAction, validateAddressAction } from "@/server/actions/orders";
import { modifyCodOrderAction } from "@/server/actions/cod";
import type { ActionResult } from "@/server/action-result";

export interface EditLineItem {
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
export interface MergeOption {
  id: string;
  name: string;
  total: string;
  lines: string;
}
export interface AddressForm {
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  country: string;
}
const ADDRESS_KEYS: (keyof AddressForm)[] = ["name", "address1", "address2", "city", "province", "zip", "country"];
const nullish = (v: string) => (v.trim() === "" ? null : v.trim());
const toAddress = (a: AddressForm, phone: string) => ({ name: nullish(a.name), address1: nullish(a.address1), address2: nullish(a.address2), city: nullish(a.city), province: nullish(a.province), zip: nullish(a.zip), country: nullish(a.country)?.toUpperCase() ?? null, phone: nullish(phone) });

type EditResult = ActionResult<{ kind: string; newOrderId?: string; newOrderName?: string; warning?: string | null }>;

/**
 * Order edit dialog shared by the core order page and the COD card. Contact, address and note are
 * edited in place; changing lines or merging orders replaces the order with a new linked one.
 * `variant="cod"` submits through the add-on (call attempt, queue) and appends to the note.
 */
export function EditOrderDialog({ slug, orderId, orderName, variant = "core", contact, address, billing, note, lines, catalog, mergeCandidates, initialMerge = [], paid = false, currency, locale, trigger = "edit" }: { slug: string; orderId: string; orderName: string; variant?: "core" | "cod"; contact: { customerName: string; phone: string; email: string }; address: AddressForm; billing?: AddressForm | null; note: string; lines: EditLineItem[]; catalog: CatalogVariant[]; mergeCandidates: MergeOption[]; initialMerge?: string[]; paid?: boolean; currency: string; locale: string; trigger?: "edit" | "merge" }) {
  const t = useTranslations("order_edit");
  const tc = useTranslations("common");
  const router = useRouter();
  const formatMoney = useMemo(() => {
    const f = new Intl.NumberFormat(locale, { style: "currency", currency });
    return (minor: number) => f.format(minor / 100);
  }, [currency, locale]);
  const cod = variant === "cod";
  const [open, setOpen] = useState(false);
  const [c, setC] = useState(contact);
  const [a, setA] = useState(address);
  const [editBilling, setEditBilling] = useState(false);
  const [b, setB] = useState<AddressForm>(billing ?? address);
  const [n, setN] = useState(cod ? "" : note);
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(lines.map((l) => [l.id, l.quantity])));
  const [added, setAdded] = useState<{ variantId: string; quantity: number }[]>([]);
  const [pick, setPick] = useState("");
  const [merge, setMerge] = useState<string[]>(initialMerge);
  const [attemptNote, setAttemptNote] = useState("");
  // COD variant only: switch the replacement to a prepaid method (the add-on drops its fee lines)
  const [payment, setPayment] = useState<"" | "card" | "bank_transfer" | "other">("");
  const tm = useTranslations("cod.modify");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<EditResult | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [suggestions, setSuggestions] = useState<{ id: string; label: string; address: Partial<Record<keyof AddressForm, string | null>> }[]>([]);
  const typed = useRef(false);

  // address autocomplete through the tenant's address provider, debounced
  useEffect(() => {
    if (!typed.current || a.address1.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const id = setTimeout(async () => {
      const r = await suggestAddressesAction(slug, a.address1, a.country || null);
      if (r.ok) setSuggestions(r.data ?? []);
    }, 300);
    return () => clearTimeout(id);
  }, [a.address1, a.country, slug]);

  const linesChanged = useMemo(() => added.some((x) => x.quantity > 0) || lines.some((l) => (qty[l.id] ?? l.quantity) !== l.quantity), [added, lines, qty]);
  const willReplace = linesChanged || merge.length > 0 || (cod && payment !== "");
  const total = lines.reduce((s, l) => s + (qty[l.id] ?? 0) * l.unitPriceMinor, 0) + added.reduce((s, x) => s + (catalog.find((v) => v.id === x.variantId)?.priceMinor ?? 0) * x.quantity, 0);
  const issueText = (code: string | undefined) => (code ? (t.has(`address_issues.${code}`) ? t(`address_issues.${code}`) : code) : null);
  const field = (form: AddressForm, set: (f: AddressForm) => void, k: keyof AddressForm, prefix: string, showIssues: boolean) => (
    <div className="space-y-1">
      <Label htmlFor={`${prefix}-${k}`}>{t(`address.${k}`)}</Label>
      <Input
        id={`${prefix}-${k}`}
        value={form[k]}
        aria-invalid={showIssues && Boolean(issues[k])}
        onChange={(e) => {
          if (prefix === "addr" && k === "address1") typed.current = true;
          setChecked(false);
          set({ ...form, [k]: e.target.value });
        }}
      />
      {showIssues && issues[k] && <p className="text-xs text-destructive" data-testid={`address-issue-${k}`}>{issueText(issues[k])}</p>}
    </div>
  );
  const checkAddress = () =>
    start(async () => {
      const r = await validateAddressAction(slug, toAddress(a, c.phone));
      if (!r.ok) return setResult(r as EditResult);
      setIssues(Object.fromEntries(r.data!.issues.map((i) => [i.field, i.code])));
      setChecked(r.data!.valid);
    });
  const submit = () =>
    start(async () => {
      setIssues({});
      const desired = willReplace ? { lines: [...lines.map((l) => ({ lineId: l.id, quantity: qty[l.id] ?? 0 })), ...added.filter((x) => x.quantity > 0).map((x) => ({ variantId: x.variantId, quantity: x.quantity }))], mergeOrderIds: merge } : {};
      const contactInput = { customerName: nullish(c.customerName), phone: nullish(c.phone), email: nullish(c.email), shippingAddress: toAddress(a, c.phone) };
      const r: EditResult = cod
        ? await modifyCodOrderAction(slug, { orderId, contact: { ...contactInput, ...(n.trim() ? { note: n.trim(), noteMode: "append" as const } : {}) }, ...desired, ...(payment ? { paymentMethod: payment } : {}), attemptNote: nullish(attemptNote) })
        : await editOrderAction(slug, { orderId, contact: { ...contactInput, ...(editBilling ? { billingAddress: toAddress(b, "") } : {}), note: n, noteMode: "replace" as const }, ...desired });
      setResult(r);
      if (!r.ok) {
        if (r.error === "invalid_address" && r.fieldErrors) setIssues(r.fieldErrors);
        return;
      }
      if (r.data?.kind === "replaced" && r.data.newOrderId) router.push(`/t/${slug}/orders/${r.data.newOrderId}`);
      else {
        setOpen(false);
        router.refresh();
      }
    });

  const triggerId = trigger === "merge" ? "merge-orders" : cod ? "modify-order" : "edit-order";
  return (
    <>
      <Button variant="outline" size={trigger === "merge" ? "sm" : "default"} onClick={() => setOpen(true)} data-testid={triggerId}>
        {trigger === "merge" ? t("merge_button") : cod ? t("cod_button") : t("button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("title", { order: orderName })}</DialogTitle>
            <DialogDescription>{cod ? t("cod_description") : t("description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <p className="font-medium">{t("contact")}</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1"><Label htmlFor="m-name">{t("customer_name")}</Label><Input id="m-name" value={c.customerName} onChange={(e) => setC({ ...c, customerName: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor="m-phone">{t("phone")}</Label><Input id="m-phone" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor="m-email">{t("email")}</Label><Input id="m-email" type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></div>
              </div>
              <p className="pt-1 font-medium">{t("shipping_address")}</p>
              <div className="grid gap-2 sm:grid-cols-2">{ADDRESS_KEYS.map((k) => <div key={k}>{field(a, setA, k, "addr", true)}</div>)}</div>
              {suggestions.length > 0 && (
                <div className="rounded-md border p-2" data-testid="address-suggestions">
                  <p className="mb-1 text-xs text-muted-foreground">{t("address_suggestions")}</p>
                  {suggestions.map((s) => (
                    <button key={s.id} type="button" data-testid="address-suggestion" className="block w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => { typed.current = false; setSuggestions([]); setChecked(false); setA({ ...a, address1: s.address.address1 ?? a.address1, address2: s.address.address2 ?? "", city: s.address.city ?? "", province: s.address.province ?? "", zip: s.address.zip ?? "", country: s.address.country ?? a.country }); }}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={checkAddress} data-testid="check-address">{t("check_address")}</Button>
                {checked && <span className="text-xs text-muted-foreground" data-testid="address-ok">{t("address_ok")}</span>}
              </div>
              {!cod && (
                <>
                  <label className="flex items-center gap-2 pt-1"><Checkbox checked={editBilling} onCheckedChange={(v) => setEditBilling(Boolean(v))} /> {t("edit_billing")}</label>
                  {editBilling && <div className="grid gap-2 sm:grid-cols-2">{ADDRESS_KEYS.map((k) => <div key={k}>{field(b, setB, k, "bill", false)}</div>)}</div>}
                </>
              )}
              <div className="space-y-1">
                <Label htmlFor="m-note">{cod ? t("note_append") : t("note")}</Label>
                <Textarea id="m-note" rows={2} value={n} onChange={(e) => setN(e.target.value)} placeholder={cod ? note || undefined : undefined} />
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
                        <td className="w-24 py-1 pl-2"><Input type="number" min={0} max={999} aria-label={`${t("quantity")} ${v?.label ?? ""}`} value={x.quantity} onChange={(e) => setAdded(added.map((y, j) => (j === i ? { ...y, quantity: Math.max(0, Number(e.target.value) || 0) } : y)))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex gap-2">
                <Input list={`catalog-${orderId}`} placeholder={t("add_product")} value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1" data-testid="add-variant" />
                <datalist id={`catalog-${orderId}`}>{catalog.map((v) => <option key={v.id} value={v.label} />)}</datalist>
                <Button type="button" variant="outline" disabled={!catalog.some((v) => v.label === pick)} onClick={() => { const v = catalog.find((x) => x.label === pick); if (v) { setAdded([...added, { variantId: v.id, quantity: 1 }]); setPick(""); } }}>{t("add")}</Button>
              </div>
              <p className="text-right text-xs text-muted-foreground">{t("new_total", { total: formatMoney(total) })}</p>
            </section>
            {mergeCandidates.length > 0 && (
              <section className="space-y-2" data-testid="merge-section">
                <p className="font-medium">{t("merge")}</p>
                <p className="text-xs text-muted-foreground">{t("merge_help")}</p>
                {mergeCandidates.map((m) => (
                  <label key={m.id} className="flex items-start gap-2">
                    <Checkbox checked={merge.includes(m.id)} aria-label={m.name} onCheckedChange={(v) => setMerge(v ? [...merge, m.id] : merge.filter((x) => x !== m.id))} />
                    <span><span className="font-medium">{m.name}</span> · {m.total}<br /><span className="text-xs text-muted-foreground">{m.lines}</span></span>
                  </label>
                ))}
              </section>
            )}
            {cod && (
              <div className="space-y-1">
                <Label htmlFor="m-payment">{tm("payment_method")}</Label>
                <Select id="m-payment" value={payment} onChange={(e) => setPayment(e.target.value as typeof payment)} data-testid="modify-payment">
                  <option value="">{tm("keep_cod")}</option>
                  {(["card", "bank_transfer", "other"] as const).map((m) => <option key={m} value={m}>{tm(`methods.${m}`)}</option>)}
                </Select>
                {payment && <p className="text-xs text-muted-foreground">{tm("payment_hint")}</p>}
              </div>
            )}
            {cod && (
              <div className="space-y-1">
                <Label htmlFor="m-attempt">{t("attempt_note")}</Label>
                <Input id="m-attempt" value={attemptNote} onChange={(e) => setAttemptNote(e.target.value)} />
              </div>
            )}
            {willReplace && <Alert><AlertDescription>{cod ? t("cod_replace_warning") : t("replace_warning")}{paid ? ` ${t("paid_warning")}` : ""}</AlertDescription></Alert>}
            {result && !result.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${result.error}`)}{result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : ""}</AlertDescription></Alert>}
            {result?.ok && result.data?.kind === "replaced" && <Alert><AlertDescription>{t("replaced_done", { order: result.data.newOrderName ?? "" })}{result.data.warning ? ` ${t("warning_not_cancelled")}` : ""}</AlertDescription></Alert>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending} data-testid={cod ? "modify-save" : "edit-save"} onClick={submit}>
              {willReplace ? t("save_replace") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
