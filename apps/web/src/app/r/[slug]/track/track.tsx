"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@keel/ui";
import { portalTrackAction, type TrackingView } from "@/server/actions/portal";

export function TrackApp({ slug, locale, timezone, primaryColor, returnsHref, lookupBy }: { slug: string; locale: string; timezone: string; primaryColor: string; returnsHref: string; lookupBy: "email" | "email_or_phone" }) {
  const t = useTranslations("return_portal");
  const to = useTranslations("order_status");
  const tsh = useTranslations("shipment_status");
  const [orderNumber, setOrderNumber] = useState("");
  const [contact, setContact] = useState("");
  const [data, setData] = useState<TrackingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const date = (iso: string | null, time = false) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", ...(time ? { timeStyle: "short" } : {}), timeZone: timezone }).format(new Date(iso)) : "—");
  const label = (fn: (k: string) => string, has: (k: string) => boolean, k: string) => (has(k) ? fn(k) : k);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold" data-testid="track-title">{t("track.title")}</h1>
      {!data && (
        <Card>
          <CardContent className="pt-6">
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start(async () => { setError(null); const r = await portalTrackAction(slug, { orderNumber, contact }); if (r.ok) setData(r.data!); else setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`, r.fieldErrors?.retryAfter ? { minutes: Math.ceil(Number(r.fieldErrors.retryAfter) / 60) } : undefined) : t("errors.generic")); }); }}>
              <div className="space-y-1.5"><Label htmlFor="tr-order">{t("lookup.order")}</Label><Input id="tr-order" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} required /></div>
              <div className="space-y-1.5"><Label htmlFor="tr-contact">{lookupBy === "email" ? t("lookup.email") : t("lookup.email_or_phone")}</Label><Input id="tr-contact" value={contact} onChange={(e) => setContact(e.target.value)} required /></div>
              {error && <Alert variant="destructive" data-testid="track-error"><AlertDescription>{error}</AlertDescription></Alert>}
              <Button type="submit" disabled={pending} style={{ backgroundColor: primaryColor, color: "#fff" }} data-testid="track-submit">{t("track.submit")}</Button>
            </form>
          </CardContent>
        </Card>
      )}
      {data && (
        <>
          <Card>
            <CardContent className="space-y-1 p-4 text-sm">
              <p className="text-lg font-semibold" data-testid="track-order">{data.orderName}</p>
              <p>{t("track.status")}: <span className="font-medium" data-testid="track-status">{label(to, to.has, data.status)}</span></p>
              <p className="text-muted-foreground">{t("track.placed", { date: date(data.placedAt) })}</p>
            </CardContent>
          </Card>
          {data.shipments.length === 0 && <p className="text-sm text-muted-foreground">{t("track.no_shipments")}</p>}
          {data.shipments.map((s, i) => (
            <Card key={i} data-testid="track-shipment">
              <CardHeader>
                <CardTitle className="text-base">{label(tsh, tsh.has, s.status)}</CardTitle>
                <p className="text-sm text-muted-foreground">{[s.carrier, s.trackingNumber].filter(Boolean).join(" · ")}{s.trackingUrl && <> · <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="underline">{t("track.carrier_link")}</a></>}</p>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{s.deliveredAt ? t("track.delivered", { date: date(s.deliveredAt) }) : s.estimatedDelivery ? t("track.expected", { date: date(s.estimatedDelivery) }) : s.shippedAt ? t("track.shipped", { date: date(s.shippedAt) }) : ""}</p>
                {s.events.length > 0 && (
                  <ol className="space-y-1 border-l pl-3">
                    {s.events.map((e, j) => <li key={j}><span className="text-xs text-muted-foreground tabular">{date(e.occurredAt, true)}</span> · {e.description ?? label(tsh, tsh.has, e.status)}{e.location ? ` · ${e.location}` : ""}</li>)}
                  </ol>
                )}
              </CardContent>
            </Card>
          ))}
          {data.returns.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("track.returns")}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">{data.returns.map((r) => <p key={r.number}>R-{r.number} · {t(`status.${r.status}`)} · {date(r.requestedAt)}</p>)}</CardContent>
            </Card>
          )}
          <a href={returnsHref} className="inline-block text-sm underline">{t("track.start_return")}</a>
        </>
      )}
    </div>
  );
}
