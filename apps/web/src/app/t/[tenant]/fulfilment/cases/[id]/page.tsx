import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@hullwise/config";
import { formatDateTime, formatMoney } from "@hullwise/core";
import { shipmentCaseDetail } from "@hullwise/services";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, PageHeader } from "@hullwise/ui";
import { StatusBadge } from "@/components/status-badge";
import { requirePage } from "@/server/tenant";
import { CaseActions } from "./case-actions";

import { withIntl } from "@/i18n/intl-scope";
/** One delivery exception or return to sender: shipment history, order and contact, and the actions of whoever claimed it. */
async function CasePage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "shipments");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("fulfilment_cases");
  const d = await ctx.run((tx) => shipmentCaseDetail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  if (!d || !d.order || !d.shipment) notFound();
  const c = d.case;
  const segment = c.kind === "exception" ? "exceptions" : "returned";
  const dt = (v: Date | null) => formatDateTime(v, ctx.locale, ctx.tenant.timezone);
  const address = (d.order.shippingAddress ?? null) as Record<string, string | null> | null;
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2">
        <Link href={`/t/${tenant}/fulfilment/${segment}`}><ArrowLeft /> {t(`${segment}_title`)}</Link>
      </Button>
      <PageHeader eyebrow={ctx.tenant.name} title={t(c.kind === "exception" ? "detail.title_exception" : "detail.title_rts", { order: d.order.name })} description={t("detail.opened", { time: dt(c.openedAt) })} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("detail.shipment")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={d.shipment.status} namespace="shipment_status" />
                {d.shipment.exceptionReason && <Badge variant="muted">{d.shipment.exceptionReason}</Badge>}
                <span className="text-muted-foreground">{d.shipment.carrier}</span>
                {d.shipment.trackingUrl ? <a href={d.shipment.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{d.shipment.trackingNumber}</a> : <span>{d.shipment.trackingNumber}</span>}
              </div>
              <p className="text-xs text-muted-foreground">{t("detail.shipped", { time: dt(d.shipment.shippedAt) })}</p>
              <ol className="relative mt-2 space-y-2 border-l pl-4" data-testid="shipment-events">
                {d.events.map((e) => (
                  <li key={e.id} className="text-xs">
                    <span className="absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full border bg-card" />
                    <StatusBadge status={e.status} namespace="shipment_status" /> <span className="text-muted-foreground">{dt(e.occurredAt)}</span>
                    {(e.description || e.location) && <p className="mt-0.5">{[e.description, e.location].filter(Boolean).join(" · ")}</p>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("detail.order")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/t/${tenant}/orders/${d.order.id}`} className="font-medium text-primary hover:underline">{d.order.name}</Link>
                <StatusBadge status={d.order.status} />
                <StatusBadge status={d.order.paymentStatus} namespace="payment_status" />
                <span className="tabular">{formatMoney(d.order.totalMinor, d.order.currency, ctx.locale)}</span>
              </div>
              <p>{d.order.customerName}</p>
              {d.order.email && <p className="text-muted-foreground"><a href={`mailto:${d.order.email}`} className="hover:underline">{d.order.email}</a></p>}
              {d.order.phone && <p className="text-muted-foreground"><a href={`tel:${d.order.phone}`} className="hover:underline">{d.order.phone}</a></p>}
              {address && <p className="text-muted-foreground">{[address.address1, address.address2, [address.zip, address.city, address.province].filter(Boolean).join(" "), address.country].filter(Boolean).join(", ")}</p>}
            </CardContent>
          </Card>
        </div>
        <CaseActions
          slug={tenant}
          canWrite={canWritePage(ctx.role, "shipments")}
          isManager={ctx.role === "owner" || ctx.role === "admin"}
          me={ctx.user.id}
          locale={ctx.locale}
          timezone={ctx.tenant.timezone}
          defaultEmail={ctx.settings.carrierInstructionEmail}
          defaultCountry={address?.country ?? ctx.tenant.country}
          orderId={d.order.id}
          caseData={{ id: c.id, kind: c.kind as "exception" | "return_to_sender", status: c.status, claimedBy: c.claimedBy, claimedByName: d.names.claimedBy, resolution: c.resolution, resolutionDetail: c.resolutionDetail as { pickupPoint?: string | null; note?: string | null; address?: Record<string, string | null> | null }, instructionChannel: c.instructionChannel, instructionTo: c.instructionTo, instructionSentAt: c.instructionSentAt?.toISOString() ?? null, instructionSentByName: d.names.instructionSentBy, closedAt: c.closedAt?.toISOString() ?? null, closeReason: c.closeReason, closedByName: d.names.closedBy, note: c.note, followUps: (c.followUps ?? {}) as Record<string, { outcome: string; at: string }> }}
          suggestions={d.suggestions}
        />
      </div>
    </>
  );
}

export default withIntl(CasePage, "app/t/[tenant]/fulfilment/cases/[id]/page.tsx");
