import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { API_LIMITS, API_SCOPES, WEBHOOK_EVENT_TYPES, WEBHOOK_HEADERS, WEBHOOK_LIMITS, WEBHOOK_RETRY_SCHEDULE_SECONDS, canDo, isModuleInPlan } from "@hullwise/config";
import { API_ERRORS } from "@hullwise/core";
import { apiRouteCatalog } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { apiBaseUrl } from "@/server/api-docs";
import { verificationSnippet } from "@/components/developers/snippets";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("api_docs"))("title") };
}

const METHOD_VARIANT = { GET: "info", POST: "success", DELETE: "destructive" } as const;

function Code({ children, testId }: { children: string; testId?: string }) {
  return <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed" data-testid={testId}>{children}</pre>;
}

/**
 * API documentation (#81), generated from the route registry (`apiRouteCatalog`): every route with
 * its scope, query parameters and body fields, the scopes, pagination, errors, limits, idempotency
 * and webhook signing. A test fails when a route, parameter, scope, error code or event type has no
 * text in the messages, so the docs cannot fall behind the API.
 */
async function ApiDocsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  if (!canDo(ctx.role, "manage_integrations") || !isModuleInPlan("core.api", ctx.tenant.planKey)) notFound();
  const t = await getTranslations("api_docs");
  const tsc = await getTranslations("developers.scopes");
  const tev = await getTranslations("developers.events");
  const td = await getTranslations("developers");
  const base = apiBaseUrl();
  const routes = apiRouteCatalog();
  const curl = `curl -H "Authorization: Bearer $TOKEN" \\\n  "${base}/orders?status=confirmed,on_hold&limit=20"`;
  const page = `{\n  "object": "list",\n  "data": [ { "id": "…", "object": "order", "name": "…", "status": "confirmed", … } ],\n  "hasMore": true,\n  "nextCursor": "eyJ2IjoxLCJsIjoib3JkZXJzIiwiayI6WyIyMDI2LTEwLTAxIDEwOjAwOjAwKzAwIiwiLi4uIl19"\n}`;
  const error = `{\n  "error": {\n    "code": "insufficient_scope",\n    "message": "This token was not granted the \\"orders:read\\" scope.",\n    "details": { "requiredScope": "orders:read" }\n  }\n}`;
  const write = `curl -X POST -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: 6f1c2e8a-adjust-0001" \\\n  -d '{"variantId":"…","locationId":"…","delta":-2,"reason":"damaged"}' \\\n  "${base}/inventory-levels/adjust"`;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/settings/developers`} className="hover:underline">← {td("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="grid gap-6" data-testid="api-docs">
        <Card>
          <CardHeader><CardTitle>{t("start.title")}</CardTitle><CardDescription>{t("start.description")}</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{t("start.base", { base })}</p>
            <p>{t("start.auth")}</p>
            <Code testId="api-docs-curl">{curl}</Code>
            <p className="text-muted-foreground">{t("start.versioning")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("scopes.title")}</CardTitle><CardDescription>{t("scopes.description")}</CardDescription></CardHeader>
          <CardContent className="p-0">
            <DataList data-testid="api-docs-scopes" rows={[...API_SCOPES]} rowKey={(s) => s} columns={[
              { key: "scope", header: t("scopes.col_scope"), mobile: "title", cell: (s) => <span className="font-mono text-xs">{s}</span> },
              { key: "what", header: t("scopes.col_what"), mobile: "subtitle", className: "text-sm", cell: (s) => tsc(s.replace(":", "_")) },
            ]} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("conventions.title")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{t("conventions.pagination", { max: API_LIMITS.maxPageSize, fallback: API_LIMITS.defaultPageSize })}</p>
            <Code>{page}</Code>
            <p>{t("conventions.filters")}</p>
            <p>{t("conventions.formats")}</p>
            <p>{t("conventions.pii")}</p>
            <p>{t("conventions.limits", { perToken: API_LIMITS.perTokenPerMinute, perTenant: API_LIMITS.perTenantPerMinute })}</p>
            <p>{t("conventions.idempotency", { hours: API_LIMITS.idempotencyTtlHours })}</p>
            <Code>{write}</Code>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("routes.title")}</CardTitle><CardDescription>{t("routes.description")}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {routes.map((r) => (
              <section key={r.id} className="rounded-lg border p-3" data-testid="api-docs-route" data-route={`${r.method} ${r.path}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={METHOD_VARIANT[r.method]}>{r.method}</Badge>
                  <code className="break-all font-mono text-sm font-medium">{r.path}</code>
                  {r.scope ? <Badge variant="outline" className="font-mono">{r.scope}</Badge> : <Badge variant="outline">{t("routes.any_token")}</Badge>}
                  {r.write && <Badge variant="muted">{t("routes.idempotent")}</Badge>}
                </div>
                <p className="mt-2 text-sm">{t(`routes.items.${r.id}`)}</p>
                {r.query.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("routes.query")}</p>
                    <ul className="mt-1 space-y-0.5 text-sm">{r.query.map((q) => <li key={q}><code className="font-mono text-xs">{q}</code> — {t(`params.${q}`)}</li>)}</ul>
                  </div>
                )}
                {r.body.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("routes.body")}</p>
                    <ul className="mt-1 space-y-0.5 text-sm">{r.body.map((b) => <li key={b}><code className="font-mono text-xs">{b}</code> — {t(`params.${b}`)}</li>)}</ul>
                  </div>
                )}
              </section>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("errors.title")}</CardTitle><CardDescription>{t("errors.description")}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Code>{error}</Code>
            <DataList data-testid="api-docs-errors" rows={Object.entries(API_ERRORS)} rowKey={([c]) => c} columns={[
              { key: "code", header: t("errors.col_code"), mobile: "title", cell: ([c]) => <span className="font-mono text-xs">{c}</span> },
              { key: "status", header: t("errors.col_status"), mobile: "badge", cell: ([, s]) => <Badge variant="outline">{s}</Badge> },
              { key: "what", header: t("errors.col_what"), mobile: "subtitle", className: "text-sm", cell: ([c]) => t(`errors.items.${c}`) },
            ]} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("webhooks.title")}</CardTitle><CardDescription>{t("webhooks.description")}</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DataList data-testid="api-docs-events" rows={[...WEBHOOK_EVENT_TYPES]} rowKey={(e) => e} columns={[
              { key: "event", header: t("webhooks.col_event"), mobile: "title", cell: (e) => <span className="font-mono text-xs">{e}</span> },
              { key: "what", header: t("webhooks.col_what"), mobile: "subtitle", className: "text-sm", cell: (e) => tev(e.replace(".", "_")) },
            ]} />
            <p>{t("webhooks.payload")}</p>
            <p>{t("webhooks.headers", { id: WEBHOOK_HEADERS.id, event: WEBHOOK_HEADERS.event, timestamp: WEBHOOK_HEADERS.timestamp, signature: WEBHOOK_HEADERS.signature })}</p>
            <p>{t("webhooks.signing", { tolerance: WEBHOOK_LIMITS.signatureToleranceSeconds, grace: WEBHOOK_LIMITS.rotationGraceHours })}</p>
            <Code testId="api-docs-snippet">{verificationSnippet()}</Code>
            <p>{t("webhooks.retries", { schedule: WEBHOOK_RETRY_SCHEDULE_SECONDS.map((s) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`)).join(" → "), timeout: WEBHOOK_LIMITS.timeoutMs / 1000 })}</p>
            <p>{t("webhooks.security")}</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default withIntl(ApiDocsPage, "app/t/[tenant]/settings/developers/docs/page.tsx");
