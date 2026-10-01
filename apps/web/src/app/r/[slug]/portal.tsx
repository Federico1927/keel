"use client";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea } from "@keel/ui";
import { portalDeletePhotoAction, portalLookupAction, portalPhotoAction, portalSubmitAction, type PortalView } from "@/server/actions/portal";

export interface PortalProps {
  slug: string;
  locale: string;
  storeName: string;
  logoUrl: string | null;
  primaryColor: string;
  title: string;
  intro: string;
  successMessage: string;
  instructions: string;
  confirmText: string;
  policyUrl: string | null;
  supportEmail: string | null;
  resolutions: string[];
  lookupBy: "email" | "email_or_phone";
  askShippedFirst: boolean;
  tracking: { mode: "off" | "optional" | "required"; carriers: string[] };
  photos: { mode: "off" | "optional" | "required"; max: number };
  exchangeNoteRequired: boolean;
  fields: { key: string; type: "text" | "textarea" | "select" | "checkbox"; required: boolean; label: string; options: { value: string; label: string }[] }[];
  reasons: { code: string; label: string }[];
  initialOrder: string;
}

type Step = "start" | "instructions" | "lookup" | "form" | "done";

/** Downscales a photo to at most 1600 px and re-encodes it as JPEG, so uploads stay small. */
async function compress(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.82));
}

export function PortalApp(p: PortalProps) {
  const t = useTranslations("return_portal");
  const [step, setStep] = useState<Step>(p.askShippedFirst ? "start" : "lookup");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState(p.initialOrder);
  const [contact, setContact] = useState("");
  const [view, setView] = useState<PortalView | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState(p.reasons[0]?.code ?? "");
  const [resolution, setResolution] = useState(p.resolutions[0] ?? "refund");
  const [exchangeNote, setExchangeNote] = useState("");
  const [carrier, setCarrier] = useState(p.tracking.carriers[0] ?? "");
  const [tracking, setTracking] = useState("");
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [holder, setHolder] = useState("");
  const [iban, setIban] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [photos, setPhotos] = useState<{ id: string; url: string }[]>([]);
  const [done, setDone] = useState<number | null>(null);
  const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const accent = { backgroundColor: p.primaryColor, color: "#fff" };
  const money = useMemo(() => (view ? new Intl.NumberFormat(p.locale, { style: "currency", currency: view.currency }) : null), [view, p.locale]);
  const date = (iso: string) => new Intl.DateTimeFormat(p.locale, { dateStyle: "medium" }).format(new Date(iso));
  const showError = (code: string, extra?: Record<string, string>) => setError(t.has(`errors.${code}`) ? t(`errors.${code}`, extra?.retryAfter ? { minutes: Math.ceil(Number(extra.retryAfter) / 60) } : undefined) : t("errors.generic"));
  const needsBank = view?.needsBankDetailsFor.includes(resolution) ?? false;
  const selected = Object.entries(qty).filter(([, q]) => q > 0);

  const lookup = () =>
    start(async () => {
      setError(null);
      const r = await portalLookupAction(p.slug, { orderNumber, contact });
      if (!r.ok) return showError(r.error, r.fieldErrors);
      setView(r.data!);
      setQty({});
      setStep("form");
    });

  const upload = (files: FileList | null) =>
    start(async () => {
      if (!files || !view) return;
      setError(null);
      for (const f of Array.from(files).slice(0, p.photos.max - photos.length)) {
        let blob: Blob;
        try {
          blob = await compress(f);
        } catch {
          showError("photo_type");
          continue;
        }
        const fd = new FormData();
        fd.set("photo", new File([blob], "photo.jpg", { type: "image/jpeg" }));
        const r = await portalPhotoAction(p.slug, view.token, fd);
        if (!r.ok) {
          showError(r.error);
          break;
        }
        setPhotos((x) => [...x, { id: r.data!.id, url: URL.createObjectURL(blob) }]);
      }
    });

  const submit = () =>
    start(async () => {
      if (!view) return;
      setError(null);
      const r = await portalSubmitAction(p.slug, view.token, {
        lines: selected.map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
        reasonCode: reason,
        resolution,
        customerNote: note || null,
        exchangeNote: resolution === "exchange" ? exchangeNote : null,
        trackingCode: p.tracking.mode !== "off" ? tracking || null : null,
        trackingCarrier: p.tracking.mode !== "off" ? carrier || null : null,
        bankHolder: needsBank ? holder : null,
        iban: needsBank ? iban : null,
        answers,
        confirmed,
        locale: p.locale,
        idempotencyKey,
      });
      if (!r.ok) return showError(r.error, r.fieldErrors);
      setDone(r.data!.number);
      setView(r.data!.view);
      setStep("done");
    });

  const errorBox = error && (
    <Alert variant="destructive" data-testid="portal-error">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="portal-title">{p.title || t("default_title")}</h1>
        {p.intro && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{p.intro}</p>}
        {p.policyUrl && <a href={p.policyUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm underline">{t("policy")}</a>}
      </div>

      {step === "start" && (
        <Card>
          <CardContent className="grid gap-3 p-6 sm:grid-cols-2">
            <Button style={accent} onClick={() => setStep("lookup")} data-testid="portal-shipped">{t("start.shipped")}</Button>
            <Button variant="outline" onClick={() => setStep("instructions")}>{t("start.not_yet")}</Button>
          </CardContent>
        </Card>
      )}

      {step === "instructions" && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("instructions_title")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="whitespace-pre-line">{p.instructions || t("instructions_default")}</p>
            <Button style={accent} onClick={() => setStep("lookup")}>{t("continue")}</Button>
          </CardContent>
        </Card>
      )}

      {step === "lookup" && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("lookup.title")}</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); lookup(); }}>
              <div className="space-y-1.5">
                <Label htmlFor="rp-order">{t("lookup.order")}</Label>
                <Input id="rp-order" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} required autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp-contact">{p.lookupBy === "email" ? t("lookup.email") : t("lookup.email_or_phone")}</Label>
                <Input id="rp-contact" value={contact} onChange={(e) => setContact(e.target.value)} required autoComplete="email" />
              </div>
              {errorBox}
              <Button type="submit" style={accent} disabled={pending} data-testid="portal-lookup">{t("lookup.submit")}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step === "form" && view && (
        <>
          <Card>
            <CardContent className="space-y-1 p-4 text-sm">
              <p className="font-medium">{t("form.hello", { name: view.firstName ?? "" })}</p>
              <p className="text-muted-foreground">{t("form.order", { order: view.orderName })}{view.deadline && view.eligible ? ` · ${t("form.deadline", { date: date(view.deadline) })}` : ""}</p>
              {view.returns.length > 0 && (
                <ul className="pt-1" data-testid="portal-existing">
                  {view.returns.map((r) => <li key={r.number}>R-{r.number} · {t(`status.${r.status}`)} · {date(r.requestedAt)}</li>)}
                </ul>
              )}
            </CardContent>
          </Card>
          {!view.eligible ? (
            <Alert variant="warning" data-testid="portal-not-eligible">
              <AlertDescription>
                {t(`ineligible.${view.ineligibleReason ?? "expired"}`)}
                {p.supportEmail && <> {t("contact_support")} <a className="underline" href={`mailto:${p.supportEmail}`}>{p.supportEmail}</a></>}
              </AlertDescription>
            </Alert>
          ) : (
            <Card>
              <CardContent className="space-y-5 p-6">
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold">{t("form.items")}</h2>
                  {view.blocked.map((l) => (
                    <div key={l.id} className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm opacity-70" data-testid="portal-blocked-line">
                      <div className="min-w-0"><p className="font-medium">{l.title}</p><p className="text-xs text-muted-foreground">{l.variantTitle}</p></div>
                      <span className="text-xs">{t(`blocks.${l.block}`)}</span>
                    </div>
                  ))}
                  {view.lines.map((l) => (
                    <div key={l.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm" data-testid="portal-line">
                      <div className="min-w-0">
                        <p className="font-medium">{l.title}</p>
                        <p className="text-xs text-muted-foreground">{[l.variantTitle, money?.format(l.unitNetMinor / 100)].filter(Boolean).join(" · ")}</p>
                      </div>
                      <Select aria-label={t("form.quantity_for", { item: l.title })} value={String(qty[l.id] ?? 0)} onChange={(e) => setQty({ ...qty, [l.id]: Number(e.target.value) })} className="w-20">
                        {Array.from({ length: l.returnable + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                      </Select>
                    </div>
                  ))}
                </section>
                <section className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="rp-reason">{t("form.reason")}</Label>
                    <Select id="rp-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                      {p.reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="rp-resolution">{t("form.resolution")}</Label>
                    <Select id="rp-resolution" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                      {p.resolutions.map((r) => <option key={r} value={r}>{t(`resolutions.${r}`)}</option>)}
                    </Select>
                  </div>
                </section>
                {resolution === "exchange" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="rp-exchange">{t("form.exchange")}{p.exchangeNoteRequired ? " *" : ""}</Label>
                    <Input id="rp-exchange" value={exchangeNote} onChange={(e) => setExchangeNote(e.target.value)} placeholder={t("form.exchange_placeholder")} />
                  </div>
                )}
                {p.tracking.mode !== "off" && (
                  <section className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    {p.tracking.carriers.length > 0 && (
                      <div className="space-y-1.5">
                        <Label htmlFor="rp-carrier">{t("form.carrier")}</Label>
                        <Select id="rp-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                          {p.tracking.carriers.map((c) => <option key={c} value={c}>{c}</option>)}
                          <option value="">{t("form.other_carrier")}</option>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="rp-tracking">{t("form.tracking")}{p.tracking.mode === "required" ? " *" : ""}</Label>
                      <Input id="rp-tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} autoComplete="off" />
                    </div>
                  </section>
                )}
                {p.photos.mode !== "off" && (
                  <section className="space-y-2">
                    <Label htmlFor="rp-photos">{t("form.photos", { max: p.photos.max })}{p.photos.mode === "required" ? " *" : ""}</Label>
                    <div className="flex flex-wrap gap-2">
                      {photos.map((ph) => (
                        <div key={ph.id} className="relative h-20 w-20 overflow-hidden rounded border">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={ph.url} alt="" className="h-full w-full object-cover" />
                          <button type="button" aria-label={t("form.remove_photo")} className="absolute right-0.5 top-0.5 rounded bg-card/90 px-1 text-xs" onClick={() => start(async () => { await portalDeletePhotoAction(p.slug, view.token, ph.id); setPhotos((x) => x.filter((y) => y.id !== ph.id)); })}>×</button>
                        </div>
                      ))}
                    </div>
                    {photos.length < p.photos.max && <input id="rp-photos" type="file" accept="image/*" multiple onChange={(e) => upload(e.target.files)} className="text-sm" data-testid="portal-photos" />}
                  </section>
                )}
                {p.fields.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    {f.type === "checkbox" ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={answers[f.key] === true} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.checked })} /> {f.label}{f.required ? " *" : ""}
                      </label>
                    ) : (
                      <>
                        <Label htmlFor={`rp-f-${f.key}`}>{f.label}{f.required ? " *" : ""}</Label>
                        {f.type === "select" ? (
                          <Select id={`rp-f-${f.key}`} value={String(answers[f.key] ?? "")} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}>
                            <option value="">—</option>
                            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        ) : f.type === "textarea" ? (
                          <Textarea id={`rp-f-${f.key}`} rows={3} value={String(answers[f.key] ?? "")} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
                        ) : (
                          <Input id={`rp-f-${f.key}`} value={String(answers[f.key] ?? "")} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
                        )}
                      </>
                    )}
                  </div>
                ))}
                {needsBank && (
                  <section className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" data-testid="portal-bank">
                    <p className="text-xs text-muted-foreground sm:col-span-2">{t("form.bank_hint")}</p>
                    <div className="space-y-1.5">
                      <Label htmlFor="rp-holder">{t("form.holder")}</Label>
                      <Input id="rp-holder" value={holder} onChange={(e) => setHolder(e.target.value)} autoComplete="name" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rp-iban">IBAN</Label>
                      <Input id="rp-iban" value={iban} onChange={(e) => setIban(e.target.value)} autoComplete="off" />
                    </div>
                  </section>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="rp-note">{t("form.note")}</Label>
                  <Textarea id="rp-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                {p.confirmText && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="portal-confirm" /> <span>{p.confirmText}</span>
                  </label>
                )}
                {errorBox}
                <Button style={accent} disabled={pending || selected.length === 0} onClick={submit} data-testid="portal-submit">{t("form.submit")}</Button>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {step === "done" && view && (
        <Card>
          <CardContent className="space-y-3 p-6 text-sm">
            <p className="text-lg font-semibold" data-testid="portal-done">{t("done.title", { number: `R-${done}` })}</p>
            {p.successMessage && <p className="whitespace-pre-line">{p.successMessage}</p>}
            {p.instructions && (
              <div>
                <p className="font-medium">{t("instructions_title")}</p>
                <p className="whitespace-pre-line text-muted-foreground">{p.instructions}</p>
              </div>
            )}
            <ul className="border-t pt-2">
              {view.returns.map((r) => <li key={r.number}>R-{r.number} · {t(`status.${r.status}`)} · {date(r.requestedAt)}</li>)}
            </ul>
            {view.eligible && <Button variant="outline" onClick={() => { setStep("form"); setQty({}); setPhotos([]); setConfirmed(false); setIdempotencyKey(newKey()); }}>{t("done.another")}</Button>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
