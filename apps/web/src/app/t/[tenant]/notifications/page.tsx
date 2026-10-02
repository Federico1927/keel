import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@keel/core";
import { listNotificationsPage } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { notificationText } from "@/components/notification-text";
import { Chip, NotificationTabs } from "./tabs";
import { MarkAllButton, ReadToggle } from "./controls";

const SEVERITY: Record<string, "info" | "warning" | "destructive" | "success"> = { info: "info", warning: "warning", critical: "destructive", success: "success" };

export default async function NotificationsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "notifications");
  const t = await getTranslations("notifications");
  const status = sp.status === "unread" || sp.status === "read" ? sp.status : undefined;
  const type = sp.type && /^[a-z_]{1,40}$/.test(sp.type) ? sp.type : undefined;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const data = await ctx.run((tx) => listNotificationsPage({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id, { status, type, page }));
  const base = `/t/${tenant}/notifications`;
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, type, ...patch })) if (v) u.set(k, v);
    return `${base}${u.size ? `?${u}` : ""}`;
  };
  const typeLabel = (k: string) => (t.has(`types.${k}`) ? t(`types.${k}`) : t("types.other"));
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={data.unread > 0 ? <MarkAllButton slug={tenant} label={t("mark_all_read")} /> : undefined} />
      <NotificationTabs ctx={ctx} active="all" />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Chip href={href({ status: undefined, page: undefined })} active={!status}>{t("filters.all")}</Chip>
        <Chip href={href({ status: "unread", page: undefined })} active={status === "unread"} testId="filter-unread">{t("filters.unread")} <span className="tabular opacity-70">{formatNumber(data.unread, ctx.locale)}</span></Chip>
        <Chip href={href({ status: "read", page: undefined })} active={status === "read"}>{t("filters.read")}</Chip>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip href={href({ type: undefined, page: undefined })} active={!type}>{t("filters.all_types")}</Chip>
        {data.types.map((ty) => (
          <Chip key={ty.type} href={href({ type: ty.type, page: undefined })} active={type === ty.type} testId={`type-${ty.type}`}>
            {typeLabel(ty.type)} <span className="tabular opacity-70">{formatNumber(ty.n, ctx.locale)}</span>
          </Chip>
        ))}
      </div>
      {data.rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {data.rows.map((n) => {
              const text = notificationText(t, n);
              const link = n.link ? (n.link.startsWith("/t/") ? n.link : `/t/${tenant}${n.link}`) : null;
              const delivered = Object.entries(n.delivered ?? {}).filter(([, v]) => v === "sent" || v === "mock" || v === "queued" || v === "duplicate").map(([k]) => t(`channels.${k}`));
              return (
                <div key={n.id} className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-start ${n.readAt ? "opacity-70" : ""}`} data-testid="notification-row">
                  <span className={`mt-1.5 hidden h-2 w-2 shrink-0 rounded-full sm:block ${n.readAt ? "bg-transparent" : "bg-primary"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={SEVERITY[n.severity] ?? "outline"}>{typeLabel(n.type)}</Badge>
                      <span>{formatDateTime(n.createdAt, ctx.locale, ctx.tenant.timezone)}</span>
                      {delivered.length > 0 && <span>{t("delivered", { channels: delivered.join(", ") })}</span>}
                    </div>
                    <p className="mt-1 text-sm font-medium">{link ? <Link href={link} className="hover:underline">{text.title}</Link> : text.title}</p>
                    {text.body && <p className="line-clamp-2 text-sm text-muted-foreground">{text.body}</p>}
                  </div>
                  <ReadToggle slug={tenant} id={n.id} read={Boolean(n.readAt)} labels={{ read: t("mark_read"), unread: t("mark_unread") }} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => href({ page: String(p) })} summary={t("pagination", { from: data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1, to: Math.min(data.page * data.pageSize, data.total), total: data.total })} />
    </>
  );
}
