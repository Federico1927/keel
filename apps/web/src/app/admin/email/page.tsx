import Link from "next/link";
import { apiEndpoint } from "@hullwise/config";
import { getLocale, getTranslations } from "next-intl/server";
import { asc, schema } from "@hullwise/db";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { EMAIL_TEMPLATE_NAMES, emailSettings, emailStats, listAddressSuppressions, listEmailLog } from "@hullwise/services";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, PageHeader, Pagination, Select, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { RemoveSuppressionButton, TestEmailForm } from "./controls";

const STATUSES = ["queued", "sending", "sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed", "expired"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_VARIANT: Record<Status, "success" | "warning" | "destructive" | "muted" | "info"> = { queued: "info", sending: "info", sent: "info", delivered: "success", delivery_delayed: "warning", bounced: "destructive", complained: "destructive", failed: "destructive", suppressed: "muted", expired: "muted" };
interface Step { title: string; body: string; verify?: boolean }

export default async function AdminEmailPage({ searchParams }: { searchParams: Promise<{ status?: string; template?: string; tenant?: string; recipient?: string; page?: string }> }) {
  const { db, user } = await requireSuperAdmin();
  const sp = await searchParams;
  const t = await getTranslations("admin.email");
  const ta = await getTranslations("admin");
  const tg = await getTranslations("integration_guide");
  const locale = await getLocale();
  const settings = emailSettings();
  const filters = { status: STATUSES.includes(sp.status as Status) ? sp.status : undefined, template: EMAIL_TEMPLATE_NAMES.includes(sp.template as never) ? sp.template : undefined, tenant: sp.tenant || undefined, recipient: sp.recipient?.trim() || undefined, page: Number(sp.page) || 1 };
  const [stats, log, tenants, suppressions] = await Promise.all([emailStats(db), listEmailLog(db, filters), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name)), listAddressSuppressions(db, 50)]);
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ status: filters.status, template: filters.template, tenant: filters.tenant, recipient: filters.recipient, ...over }).filter((e): e is [string, string] => Boolean(e[1])));
    return `/admin/email${q.size ? `?${q}` : ""}`;
  };
  const steps = tg.raw("email.steps") as Step[];
  const webhookUrl = apiEndpoint("/webhooks/email");
  const stateVariant = settings.state === "configured" ? "success" : settings.state === "not_configured" ? "destructive" : "warning";
  return (
    <>
      <PageHeader eyebrow={ta("console")} title={t("title")} description={t("description")} />
      {settings.state !== "configured" && (
        <Alert variant={settings.state === "not_configured" ? "destructive" : "warning"} className="mb-4" data-testid="email-not-configured">
          <AlertTitle>{t(`state.${settings.state}`)}</AlertTitle>
          <AlertDescription>{t(`state_hint.${settings.state}`, { from: settings.from })}</AlertDescription>
        </Alert>
      )}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">{t("status_title")} <Badge variant={stateVariant} data-testid="email-provider-state">{t(`state.${settings.state}`)}</Badge></CardTitle>
            {settings.state === "configured" && <CardDescription>{t("state_hint.configured", { from: settings.from })}</CardDescription>}
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("from")}</dt>
              <dd className="break-all">{settings.from}{!settings.fromConfigured && <span className="block text-xs text-warning">{t("from_missing")}</span>}</dd>
              <dt className="text-muted-foreground">{t("reply_to")}</dt>
              <dd className="break-all">{settings.replyTo ?? t("none")}</dd>
              <dt className="text-muted-foreground">{t("webhook")}</dt>
              <dd>{settings.webhookConfigured ? t("webhook_on") : <span className="text-warning">{t("webhook_off")}</span>}<span className="block break-all font-mono text-xs text-muted-foreground">{webhookUrl}</span></dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("test_title")}</CardTitle>
            <CardDescription>{t("test_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <TestEmailForm defaultTo={user.email} />
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-2 text-sm font-semibold">{t("stats_title")}</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="email-stats">
        {(["sent", "delivered", "bounced", "complained", "failed", "suppressed"] as const).map((k) => (
          <Stat key={k} label={t(`stats.${k}`)} value={formatNumber(stats[k], locale)} href={href({ status: k === "sent" ? undefined : k, page: undefined })} />
        ))}
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t("log_title")}</CardTitle>
          <CardDescription>{t("privacy")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form method="get" action="/admin/email" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="f-status">{t("filters.status")}</Label>
              <Select id="f-status" name="status" defaultValue={filters.status ?? ""}>
                <option value="">{t("filters.all")}</option>
                {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-template">{t("filters.template")}</Label>
              <Select id="f-template" name="template" defaultValue={filters.template ?? ""}>
                <option value="">{t("filters.all")}</option>
                {EMAIL_TEMPLATE_NAMES.map((n) => <option key={n} value={n}>{t(`templates.${n}`)}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-tenant">{t("filters.tenant")}</Label>
              <Select id="f-tenant" name="tenant" defaultValue={filters.tenant ?? ""}>
                <option value="">{t("filters.all")}</option>
                <option value="platform">{t("filters.platform")}</option>
                {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-recipient">{t("filters.recipient")}</Label>
              <Input id="f-recipient" name="recipient" type="email" defaultValue={filters.recipient ?? ""} autoComplete="off" />
            </div>
            <div className="flex gap-2">
              <Button type="submit">{t("filters.apply")}</Button>
              <Link href="/admin/email" className="flex h-9 items-center rounded-md border px-3 text-sm">{t("filters.reset")}</Link>
            </div>
          </form>
          {log.rows.length === 0 ? (
            <EmptyState title={t("empty")} />
          ) : (
            <div className="-mx-6 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.when")}</TableHead>
                    <TableHead>{t("columns.tenant")}</TableHead>
                    <TableHead>{t("columns.template")}</TableHead>
                    <TableHead>{t("columns.recipient")}</TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                    <TableHead className="text-right">{t("columns.attempts")}</TableHead>
                    <TableHead>{t("columns.provider")}</TableHead>
                    <TableHead>{t("columns.error")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {log.rows.map((r) => (
                    <TableRow key={r.id} data-testid="email-row">
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt, locale, "UTC")}</TableCell>
                      <TableCell className="text-xs">{r.tenantName ?? <span className="text-muted-foreground">{t("platform")}</span>}</TableCell>
                      <TableCell className="text-xs">{t(`templates.${r.template as "test"}`)}<span className="block text-muted-foreground">{r.category} · {r.locale}</span></TableCell>
                      <TableCell className="font-mono text-xs">{r.recipientMasked}</TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[r.status as Status] ?? "muted"}>{t(`status.${r.status as Status}`)}</Badge></TableCell>
                      <TableCell className="text-right tabular text-xs">{r.attempts}</TableCell>
                      <TableCell className="max-w-[10rem] truncate font-mono text-xs text-muted-foreground" title={r.providerMessageId ?? ""}>{r.provider ? `${r.provider}${r.providerMessageId ? ` · ${r.providerMessageId}` : ""}` : t("none")}</TableCell>
                      <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground" title={r.lastError ?? ""}>{r.lastErrorCode ? <span className="font-mono">{r.lastErrorCode}</span> : null}{r.lastError ? ` ${r.lastError}` : ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pagination page={log.page} pageSize={log.pageSize} total={log.total} hrefFor={(p) => href({ page: String(p) })} summary={t("pagination", { from: log.total === 0 ? 0 : (log.page - 1) * log.pageSize + 1, to: Math.min(log.page * log.pageSize, log.total), total: log.total })} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("suppressions_title")}</CardTitle>
            <CardDescription>{t("suppressions_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {suppressions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("suppressions_empty")}</p>
            ) : (
              <ul className="divide-y text-sm">
                {suppressions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 py-2" data-testid="suppression-row">
                    <span className="font-mono text-xs">{s.emailMasked}</span>
                    <Badge variant={s.reason === "bounce" ? "destructive" : "warning"}>{t(`suppression_reason.${s.reason as "bounce"}`)}</Badge>
                    <span className="text-xs text-muted-foreground">{t(`suppression_source.${s.source as "provider"}`)} · {formatDateTime(s.createdAt, locale, "UTC")}</span>
                    <span className="ml-auto"><RemoveSuppressionButton id={s.id} /></span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <details>
            <summary className="cursor-pointer list-none p-6 pb-4">
              <span className="text-base font-semibold">{t("guide_title")}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{tg("email.intro")}</span>
            </summary>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">{tg("verify_legend")}</p>
              <ol className="space-y-3 text-sm">
                {steps.map((s, i) => (
                  <li key={i} data-testid="email-guide-step">
                    <div className="flex flex-wrap items-center gap-2 font-medium">{i + 1}. {s.title}{s.verify && <Badge variant="warning">{tg("verify_badge")}</Badge>}</div>
                    <p className="mt-1 text-muted-foreground">{s.body.replace("{emailWebhookUrl}", webhookUrl)}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </details>
        </Card>
      </div>
    </>
  );
}
