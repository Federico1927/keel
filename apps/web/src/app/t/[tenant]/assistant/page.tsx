import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ExternalLink, Plus } from "lucide-react";
import { canDo, canWritePage } from "@keel/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, type AssistantCitation, type CitationFigure } from "@keel/core";
import { assistantThread, assistantToolsFor, assistantUsage, getLlmProviderFor, listAssistantThreads } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { AskForm, DeleteThreadButton } from "./ask-form";

const SUGGESTIONS = ["revenue", "profit", "campaigns", "products", "returns", "churn", "stock"] as const;
const TOOL_FOR_SUGGESTION: Record<(typeof SUGGESTIONS)[number], string> = { revenue: "get_kpis", profit: "get_profit_and_loss", campaigns: "get_campaigns", products: "get_top_products", returns: "get_returns_summary", churn: "get_customer_predictions", stock: "get_stock_risk" };

export default async function AssistantPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ thread?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "assistant");
  const t = await getTranslations("assistant");
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const { threads, thread, usage, llm } = await ctx.run(async (tx) => ({
    threads: await listAssistantThreads(s(tx), ctx.user.id),
    thread: sp.thread ? await assistantThread(s(tx), ctx.user.id, sp.thread) : null,
    usage: await assistantUsage(s(tx)),
    llm: await getLlmProviderFor(s(tx)),
  }));
  const canAsk = canWritePage(ctx.role, "assistant");
  const tools = new Set(assistantToolsFor(ctx.role, ctx.activeAddons).map((x) => x.name));
  const suggestions = SUGGESTIONS.filter((k) => tools.has(TOOL_FOR_SUGGESTION[k])).map((k) => t(`suggestions.${k}`));
  const connected = !!llm;
  const isMock = llm?.provider === "mock";
  const base = `/t/${tenant}/assistant`;
  const num = (n: number) => formatNumber(n, ctx.locale);

  const figure = (f: CitationFigure) => {
    if (f.value === null || f.value === undefined) return "—";
    if (f.format === "money") return formatMoney(Number(f.value), ctx.tenant.currency, ctx.locale);
    if (f.format === "percent") return formatPercent(Number(f.value), ctx.locale);
    if (f.format === "ratio") return `${formatNumber(Number(f.value), ctx.locale, { maximumFractionDigits: 2 })}×`;
    if (f.format === "days") return t("days", { n: Math.round(Number(f.value)) });
    if (f.format === "text") return t.has(`values.${String(f.value)}`) ? t(`values.${String(f.value)}`) : String(f.value);
    return num(Number(f.value));
  };
  const change = (c: number | null | undefined) =>
    c === null || c === undefined ? null : <span className={cn("ml-1 text-xs", c >= 0 ? "text-success" : "text-destructive")}>{c >= 0 ? "+" : ""}{formatPercent(c, ctx.locale)}</span>;
  const day = (d: string) => formatDate(`${d}T12:00:00Z`, ctx.locale, "UTC");

  const citationCard = (c: AssistantCitation, i: number) => (
    <Card key={i} data-testid="assistant-citation" data-tool={c.tool} className="bg-muted/30">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div>
          <CardTitle className="text-sm">{t(`tools.${c.tool}`)}</CardTitle>
          <CardDescription className="text-xs" data-testid="citation-scope">
            {c.period ? t("period", { from: day(c.period.from), to: day(c.period.to) }) : t("current_data")}
            {Object.entries(c.filters).map(([k, v]) => <span key={k}> · {t(`filters.${k}`)}: {t.has(`values.${v}`) ? t(`values.${v}`) : v}</span>)}
          </CardDescription>
        </div>
        <Link href={c.href} className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline" data-testid="citation-link">{t("open_source")} <ExternalLink className="h-3 w-3" /></Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {c.figures.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            {c.figures.map((f) => (
              <div key={f.key}>
                <dt className="text-xs text-muted-foreground">{t(`figures.${f.key}`)}</dt>
                <dd className="font-medium tabular-nums">{figure(f)}{change(f.change)}</dd>
              </div>
            ))}
          </dl>
        )}
        {c.rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  {c.rows[0]!.figures.map((f) => <TableHead key={f.key} className="text-right">{t(`figures.${f.key}`)}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.rows.map((r, j) => (
                  <TableRow key={j}>
                    <TableCell className="max-w-56 truncate">{r.href ? <Link href={r.href} className="hover:underline">{r.label}</Link> : r.label}</TableCell>
                    {r.figures.map((f) => <TableCell key={f.key} className="text-right tabular-nums">{figure(f)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<Link href={base} className="flex items-center gap-1 text-sm text-primary hover:underline" data-testid="assistant-new"><Plus className="h-4 w-4" /> {t("new_thread")}</Link>} />
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{t("threads")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm" data-testid="assistant-threads">
              {threads.length === 0 && <p className="text-muted-foreground">{t("no_threads")}</p>}
              {threads.map((th) => (
                <Link key={th.id} href={`${base}?thread=${th.id}`} className={cn("block truncate rounded-sm px-2 py-1.5 hover:bg-muted", th.id === thread?.id && "bg-muted font-medium")} title={th.title}>
                  {th.title}
                  <span className="block text-xs font-normal text-muted-foreground">{formatDateTime(th.updatedAt, ctx.locale, ctx.tenant.timezone)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
          <Card data-testid="assistant-usage">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("usage.title")}</CardTitle>
              <CardDescription className="text-xs">{t("usage.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("usage.questions")}</span><span className="tabular-nums">{num(usage.questions)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("usage.input_tokens")}</span><span className="tabular-nums">{num(usage.inputTokens)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("usage.output_tokens")}</span><span className="tabular-nums">{num(usage.outputTokens)}</span></div>
            </CardContent>
          </Card>
        </aside>

        <section className="min-w-0 space-y-4">
          {!connected && (
            <Card data-testid="assistant-not-connected">
              <CardHeader>
                <CardTitle className="text-base">{t("not_connected.title")}</CardTitle>
                <CardDescription>{t("not_connected.description")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3 text-sm">
                {canDo(ctx.role, "manage_integrations") ? (
                  <Link href={`/t/${tenant}/integrations`} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90" data-testid="assistant-connect-link">{t("not_connected.connect")}</Link>
                ) : (
                  <span className="text-muted-foreground">{t("not_connected.ask_owner")}</span>
                )}
                <Link href={`/t/${tenant}/integrations/guide/anthropic`} className="px-1 py-1.5 underline-offset-4 hover:underline">{t("not_connected.guide")}</Link>
              </CardContent>
            </Card>
          )}
          {isMock && (
            <Alert data-testid="assistant-mock-note"><AlertDescription>{t("mock_note")}</AlertDescription></Alert>
          )}
          {sp.thread && !thread && <Alert><AlertDescription>{t("thread_not_found")}</AlertDescription></Alert>}
          {thread ? (
            <div className="space-y-4" data-testid="assistant-thread">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-sm font-medium text-muted-foreground">{thread.title}</h2>
                {canAsk && <DeleteThreadButton slug={tenant} threadId={thread.id} />}
              </div>
              {thread.messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" data-testid="assistant-question">{m.text}</div>
                ) : (
                  <div key={m.id} className="space-y-3" data-testid="assistant-answer">
                    {m.text && <div className="whitespace-pre-wrap rounded-lg border bg-card px-4 py-3 text-sm leading-relaxed">{m.text}</div>}
                    {m.errorCode && <Alert variant="destructive" data-testid="assistant-error"><AlertDescription>{t(`errors.${m.errorCode}`)}</AlertDescription></Alert>}
                    {m.stopReason === "refusal" && <Alert data-testid="assistant-refusal"><AlertDescription>{t("refused")}</AlertDescription></Alert>}
                    {(m.stopReason === "max_tokens" || (m.stopReason === "tool_use" && !m.errorCode)) && <Alert><AlertDescription>{t("truncated")}</AlertDescription></Alert>}
                    {m.tools.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {t("sources")}: {[...new Set(m.tools)].map((x) => <Badge key={x} variant="outline">{t(`tools.${x}`)}</Badge>)}
                      </div>
                    )}
                    {m.citations.map(citationCard)}
                  </div>
                ),
              )}
            </div>
          ) : connected && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("empty_title")}</CardTitle>
                <CardDescription>{t("empty_description")}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {t("scope", { tools: [...tools].map((x) => t(`tools.${x}`)).join(", ") })}
              </CardContent>
            </Card>
          )}
          {connected && (canAsk ? <AskForm slug={tenant} threadId={thread?.id ?? null} suggestions={thread ? [] : suggestions} /> : <p className="text-sm text-muted-foreground">{t("read_only")}</p>)}
        </section>
      </div>
    </>
  );
}
