import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime } from "@hullwise/core";
import { mockEmailOutbox } from "@hullwise/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, cn } from "@hullwise/ui";
import { isDevInboxEnabled } from "@/server/dev-inbox";

export const dynamic = "force-dynamic";

/** Dev inbox (issue #51): the emails the mock provider captured in this process, with an HTML preview. Development only. */
export default async function DevEmailsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  if (!isDevInboxEnabled()) notFound();
  const { id } = await searchParams;
  const t = await getTranslations("dev_inbox");
  const locale = await getLocale();
  const mails = [...mockEmailOutbox().sent].reverse();
  const current = mails.find((m) => m.id === id) ?? mails[0];
  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <PageHeader title={t("title")} description={t("description")} actions={<Badge variant="muted">{t("count", { count: mails.length })}</Badge>} />
      {!current ? (
        <EmptyState title={t("empty")} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <ul className="max-h-[75vh] divide-y overflow-y-auto rounded-lg border bg-card text-sm">
            {mails.map((m) => (
              <li key={m.id}>
                <Link href={`/dev/emails?id=${m.id}`} data-testid="dev-email" className={cn("block px-3 py-2 hover:bg-muted", m.id === current.id && "bg-muted")}>
                  <span className="block truncate font-medium">{m.message.subject}</span>
                  <span className="block truncate text-xs text-muted-foreground">{m.message.to} · {formatDateTime(m.sentAt, locale, "UTC")}</span>
                  {m.message.tags?.template && <Badge variant="outline" className="mt-1">{m.message.tags.template}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
          <Card>
            <CardContent className="space-y-3 pt-6">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("subject")}</dt>
                <dd className="font-medium">{current.message.subject}</dd>
                <dt className="text-muted-foreground">{t("to")}</dt>
                <dd>{current.message.to}</dd>
                <dt className="text-muted-foreground">{t("when")}</dt>
                <dd>{formatDateTime(current.sentAt, locale, "UTC")}</dd>
              </dl>
              <h2 className="text-sm font-semibold">{t("html")}</h2>
              <iframe title={current.message.subject} srcDoc={current.message.html.replace("<head>", '<head><base target="_blank">')} sandbox="allow-popups allow-popups-to-escape-sandbox" className="h-[32rem] w-full rounded-md border bg-card" />
              <h2 className="text-sm font-semibold">{t("text")}</h2>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 text-xs">{current.message.text}</pre>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}
