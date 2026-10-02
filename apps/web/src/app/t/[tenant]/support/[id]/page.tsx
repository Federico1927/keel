import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canWritePage } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { supportTicketThread } from "@hullwise/services";
import { Badge, DetailShell } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { STATUS_VARIANT } from "../status";
import { SupportThread } from "@/components/support-thread";
import { CloseTicketButton, TenantReplyForm } from "./reply";

export default async function SupportTicketPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePage(tenant, "support");
  const t = await getTranslations("support");
  const data = await ctx.run((tx) => supportTicketThread({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  if (!data) notFound();
  const { ticket, messages } = data;
  const canWrite = canWritePage(ctx.role, "support");
  return (
    <DetailShell
      back={<Link href={`/t/${tenant}/support`} className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-4 w-4" /> {t("title")}</Link>}
      eyebrow={t(`categories.${ticket.category}`)}
      title={`#${ticket.number} · ${ticket.subject}`}
      chips={<><Badge variant={STATUS_VARIANT[ticket.status] ?? "muted"} data-testid="ticket-status">{t(`statuses.${ticket.status}`)}</Badge><span className="text-xs text-muted-foreground">{formatDateTime(ticket.createdAt, ctx.locale, ctx.tenant.timezone)}</span></>}
      actions={canWrite && ticket.status !== "closed" ? <CloseTicketButton slug={tenant} ticketId={ticket.id} label={t("close")} /> : undefined}
    >
      <SupportThread
        messages={messages.map((m) => ({ id: m.id, side: m.side, author: m.side === "platform" ? t("platform") : m.authorId === ctx.user.id ? t("you") : (m.authorName ?? m.authorEmail ?? "—"), body: m.body, at: formatDateTime(m.createdAt, ctx.locale, ctx.tenant.timezone), attachment: m.attachmentName ? { name: m.attachmentName, href: `/t/${tenant}/support/attachments/${m.id}` } : null }))}
        downloadLabel={t("download")}
      />
      {ticket.status === "closed" && <p className="text-sm text-muted-foreground">{t("closed_hint")}</p>}
      {canWrite && <TenantReplyForm slug={tenant} ticketId={ticket.id} />}
    </DetailShell>
  );
}
