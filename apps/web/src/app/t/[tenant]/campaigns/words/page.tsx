import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatNumber, formatPercent, type NgramRow } from "@hullwise/core";
import { WORD_SOURCES, adsWords, type WordSource } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { periodParams, resolvePeriod } from "@/server/period";
import { PeriodPicker } from "@/components/period-picker";
import { AdsNav } from "../ads-table";

type SP = { preset?: string; from?: string; to?: string; source?: string; n?: string; sort?: string };

/** Words tab: 1–3 word phrases of ad copy, search terms or keywords, with Hullwise profit; 90 days by default (words need volume). */
export default async function WordsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<SP> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "campaigns");
  const t = await getTranslations("ads");
  const period = resolvePeriod(sp, ctx.tenant.timezone, "90d");
  const source = (WORD_SOURCES as readonly string[]).includes(sp.source ?? "") ? (sp.source as WordSource) : "copy";
  const n = sp.n === "1" || sp.n === "2" || sp.n === "3" ? (Number(sp.n) as 1 | 2 | 3) : null;
  const sort = sp.sort === "roas" ? "roas" : "profit";
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const langs = [ctx.tenant.defaultLocale, ctx.locale];
  const data = await ctx.run((tx) => adsWords({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at, period, { source, n, sort, langs, limit: 20 }));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const keep = { ...periodParams(period, sp), source, n: n ? String(n) : undefined, sort };
  const href = (patch: Record<string, string | undefined>) => `/t/${tenant}/campaigns/words?${new URLSearchParams(Object.entries({ ...keep, ...patch }).filter((e): e is [string, string] => Boolean(e[1])))}`;
  const qs = new URLSearchParams(Object.entries(periodParams(period, sp)).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const tabs = (items: readonly (readonly [string, string | undefined, string])[], current: string | undefined, key: string) => (
    <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm">
      {items.map(([label, value, testId]) => <Link key={label} href={href({ [key]: value })} className={cn("rounded-sm px-3 py-1.5", current === value ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={testId}>{label}</Link>)}
    </div>
  );
  const table = (rows: NgramRow[], testId: string) => (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("cols.phrase")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("cols.items")}</TableHead>
          <TableHead className="text-right">{t("cols.spend")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("cols.ctr")}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">{t("cols.platform_conv")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("cols.hullwise_orders")}</TableHead>
          <TableHead className="text-right">{t("cols.profit")}</TableHead>
          <TableHead className="text-right">{t("cols.roas")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.phrase} data-testid="word-row">
            <TableCell className="font-medium" data-testid="word-phrase">{r.phrase}</TableCell>
            <TableCell className="hidden text-right tabular sm:table-cell">{formatNumber(r.items, ctx.locale)}</TableCell>
            <TableCell className="text-right tabular">{money(r.spendMinor)}</TableCell>
            <TableCell className="hidden text-right tabular md:table-cell">{formatPercent(r.ctr, ctx.locale, 2)}</TableCell>
            <TableCell className="hidden text-right tabular lg:table-cell">{formatNumber(Math.round(r.conversions), ctx.locale)}</TableCell>
            <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(r.orders, ctx.locale)}</TableCell>
            <TableCell className={cn("text-right tabular font-medium", r.profitMinor < 0 && "text-destructive")}>{money(r.profitMinor)}</TableCell>
            <TableCell className="text-right tabular">{r.roas === null ? "—" : `${r.roas.toFixed(2)}×`}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("words_title")} description={t("words_description")} actions={<PeriodPicker basePath={`/t/${tenant}/campaigns/words`} keep={{ source, n: keep.n, sort }} preset={period.preset} from={sp.from} to={sp.to} />} />
      <AdsNav tenant={tenant} active="words" qs={qs} />
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs(WORD_SOURCES.map((s) => [t(`word_source.${s}`), s, `words-source-${s}`] as const), source, "source")}
        {tabs([[t("ngram.all"), undefined, "words-n-all"], [t("ngram.n1"), "1", "words-n-1"], [t("ngram.n2"), "2", "words-n-2"], [t("ngram.n3"), "3", "words-n-3"]] as const, n ? String(n) : undefined, "n")}
        {tabs([[t("sort.profit"), "profit", "words-sort-profit"], [t("sort.roas"), "roas", "words-sort-roas"]] as const, sort, "sort")}
      </div>
      {data.rows.length === 0 ? <EmptyState title={t("no_words")} description={t("no_words_hint")} /> : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("winners")}</CardTitle><CardDescription>{t("winners_description")}</CardDescription></CardHeader>
            <CardContent className="p-0">{data.winners.length ? table(data.winners, "words-winners") : <EmptyState title={t("no_winners")} className="m-4" />}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("losers")}</CardTitle><CardDescription>{t("losers_description")}</CardDescription></CardHeader>
            <CardContent className="p-0">{data.losers.length ? table(data.losers, "words-losers") : <EmptyState title={t("no_losers")} className="m-4" />}</CardContent>
          </Card>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("words_footnote", { items: data.items })}</p>
    </>
  );
}
