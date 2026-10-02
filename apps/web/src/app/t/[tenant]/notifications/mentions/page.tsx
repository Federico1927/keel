import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber, tokenizeMentions } from "@hullwise/core";
import { MENTION_ENTITY_TYPES, listMentions } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { Chip, NotificationTabs } from "../tabs";
import { MarkAllButton, ReadToggle } from "../controls";

export default async function MentionsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "notifications");
  const t = await getTranslations("notifications");
  const status = sp.status === "unread" || sp.status === "read" ? sp.status : undefined;
  const entityType = (MENTION_ENTITY_TYPES as readonly string[]).includes(sp.entity ?? "") ? sp.entity : undefined;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const data = await ctx.run((tx) => listMentions({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id, { status, entityType, page }));
  const base = `/t/${tenant}/notifications/mentions`;
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, entity: entityType, ...patch })) if (v) u.set(k, v);
    return `${base}${u.size ? `?${u}` : ""}`;
  };
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("mentions.title")} description={t("mentions.description")} actions={data.unread > 0 ? <MarkAllButton slug={tenant} label={t("mentions.mark_all_read")} kind="mention" /> : undefined} />
      <NotificationTabs ctx={ctx} active="mentions" />
      <div className="-mx-4 mb-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-wrap md:px-0">
        <Chip href={href({ status: undefined, page: undefined })} active={!status}>{t("filters.all")}</Chip>
        <Chip href={href({ status: "unread", page: undefined })} active={status === "unread"}>{t("filters.unread")} <span className="tabular opacity-70">{formatNumber(data.unread, ctx.locale)}</span></Chip>
        <Chip href={href({ status: "read", page: undefined })} active={status === "read"}>{t("filters.read")}</Chip>
        <span className="mx-1 hidden h-4 border-l sm:inline-block" />
        <Chip href={href({ entity: undefined, page: undefined })} active={!entityType}>{t("mentions.entity.all")}</Chip>
        {MENTION_ENTITY_TYPES.map((e) => (
          <Chip key={e} href={href({ entity: e, page: undefined })} active={entityType === e}>{t(`mentions.entity.${e}`)}</Chip>
        ))}
      </div>
      {data.rows.length === 0 ? (
        <EmptyState title={t("mentions.empty_title")} description={t("mentions.empty_description")} />
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {data.rows.map(({ m, authorName, authorEmail }) => (
              <div key={m.id} className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-start ${m.readAt ? "opacity-70" : ""}`} data-testid="mention-row">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{t(`mentions.entity.${m.entityType}`)}</Badge>
                    <span>{formatDateTime(m.createdAt, ctx.locale, ctx.tenant.timezone)}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium">
                    <Link href={`/t/${tenant}${m.link}`} className="hover:underline">{t("mentions.by", { author: authorName ?? authorEmail ?? "—", record: m.entityLabel })}</Link>
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {tokenizeMentions(m.excerpt).map((tok, i) => (tok.type === "text" ? <span key={i}>{tok.value}</span> : <span key={i} className="rounded bg-accent px-1 text-accent-foreground">@{tok.label}</span>))}
                  </p>
                </div>
                <ReadToggle slug={tenant} id={m.id} read={Boolean(m.readAt)} labels={{ read: t("mark_read"), unread: t("mark_unread") }} kind="mention" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(p) => href({ page: String(p) })} summary={t("pagination", { from: data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1, to: Math.min(data.page * data.pageSize, data.total), total: data.total })} />
    </>
  );
}
