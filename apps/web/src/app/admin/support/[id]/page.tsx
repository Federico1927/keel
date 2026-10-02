import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { formatDateTime } from "@hullwise/core";
import { adminSupportThread } from "@hullwise/services";
import { Badge, DetailShell } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { STATUS_VARIANT } from "@/app/t/[tenant]/support/status";
import { SupportThread } from "@/components/support-thread";
import { AdminReplyForm, AdminStatusButton } from "./reply";

import { withIntl } from "@/i18n/intl-scope";
async function AdminSupportTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin");
  const ts = await getTranslations("support");
  const locale = await getLocale();
  const data = await adminSupportThread(db, id);
  if (!data) notFound();
  return (
    <DetailShell
      back={<Link href="/admin/support" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-4 w-4" /> {t("support.title")}</Link>}
      eyebrow={data.tenantName}
      title={`#${data.t.number} · ${data.t.subject}`}
      chips={<><Badge variant={STATUS_VARIANT[data.t.status] ?? "muted"} data-testid="ticket-status">{ts(`statuses.${data.t.status}`)}</Badge><span className="text-xs text-muted-foreground">{ts(`categories.${data.t.category}`)} · {t("support.author")}: {data.authorEmail ?? "—"}</span></>}
      actions={<AdminStatusButton ticketId={data.t.id} status={data.t.status === "closed" ? "open" : "closed"} label={data.t.status === "closed" ? t("support.reopen") : t("support.close")} />}
    >
      <SupportThread
        platformRight
        messages={data.messages.map((m) => ({ id: m.id, side: m.side, author: m.side === "platform" ? `${ts("platform")} · ${m.authorEmail ?? ""}` : (m.authorName ?? m.authorEmail ?? "—"), body: m.body, at: formatDateTime(m.createdAt, locale, "UTC"), attachment: m.attachmentName ? { name: m.attachmentName, href: `/admin/support/attachments/${m.id}` } : null }))}
        downloadLabel={ts("download")}
      />
      <p className="text-xs text-muted-foreground">{t("support.attachment_audit")}</p>
      <AdminReplyForm ticketId={data.t.id} />
    </DetailShell>
  );
}

export default withIntl(AdminSupportTicketPage, "app/admin/support/[id]/page.tsx");
