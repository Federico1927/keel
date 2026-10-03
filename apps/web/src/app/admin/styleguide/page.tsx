import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { brandColorsFor, contrastRatio, formatMoney, formatNumber } from "@hullwise/core";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, PageHeader, Select, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { BRAND_SURFACES, THEMES, TOKENS, type Theme, type ThemeTokens } from "@hullwise/ui/tokens";
import { requireSuperAdmin } from "@/server/admin";
import { RevenueChart } from "@/components/charts/revenue-chart";
import { StatusBadge } from "@/components/status-badge";
import { brandStyle } from "@/server/branding";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("styleguide"))("title") };
}

const SWATCHES: (keyof ThemeTokens)[] = ["bg", "surface", "surface-2", "fg", "muted", "line", "line-strong", "primary", "success", "warning", "danger", "info", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"];
/** Sample brand colours: one that passes as is, one too light, one too dark for the dark theme. */
// eslint-disable-next-line no-restricted-syntax -- sample input colours, not styling
const BRAND_SAMPLES = ["#7c3aed", "#f5b700", "#14532d"];
const DEMO_SERIES = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10), orders: 30 + Math.round(12 * Math.sin(i / 3)) + (i % 7 === 5 ? 18 : 0), grossRevenueMinor: (2400 + Math.round(900 * Math.sin(i / 4)) + i * 35) * 100 }));

/**
 * Direction A, decided by the committente on 2026-10-01 (#44): the tokens, real components in both
 * themes, the tenant brand-colour variants (AA-adjusted) and the two densities. Super-admin only.
 */
async function StyleguidePage() {
  await requireSuperAdmin();
  const t = await getTranslations("styleguide");
  const td = await getTranslations("dashboard");
  const tt = await getTranslations("theme");
  const locale = await getLocale();
  const money = (m: number) => formatMoney(m, "EUR", locale);
  const sample = (theme: Theme) => (
    <div className={`${theme} space-y-4 rounded-xl border bg-background p-4 text-foreground`} data-testid={`styleguide-${theme}`}>
      <p className="text-sm font-semibold">{tt(theme)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={td("kpi.revenue")} value={money(482_350)} trend={{ value: 0.124 }} hint={td("vs_yesterday")} />
        <Stat label={td("kpi.orders")} value={formatNumber(87, locale)} trend={{ value: -0.031 }} hint={td("vs_last_week")} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{td("revenue_30d")}</CardTitle>
        </CardHeader>
        <CardContent>
          <RevenueChart data={DEMO_SERIES} locale={locale} currency="EUR" ordersLabel={td("kpi.orders").toLowerCase()} />
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button size="sm">{t("primary")}</Button>
        <Button size="sm" variant="outline">{t("secondary")}</Button>
        <Button size="sm" variant="ghost">{t("ghost")}</Button>
        <Button size="sm" variant="destructive">{t("danger")}</Button>
        <a className="self-center text-sm font-medium text-primary underline-offset-4 hover:underline" href="#tokens">{t("link")}</a>
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status="new" />
        <StatusBadge status="confirmed" />
        <StatusBadge status="shipped" />
        <StatusBadge status="delivered" />
        <StatusBadge status="on_hold" />
        <StatusBadge status="cancelled" />
        <Badge variant="success">{t("success")}</Badge>
        <Badge variant="warning">{t("warning")}</Badge>
        <Badge variant="destructive">{t("danger")}</Badge>
        <Badge variant="info">{t("info")}</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`sg-in-${theme}`}>{t("input")}</Label>
          <Input id={`sg-in-${theme}`} placeholder={t("placeholder")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`sg-sel-${theme}`}>{t("select")}</Label>
          <Select id={`sg-sel-${theme}`} defaultValue="a">
            <option value="a">{t("option")} A</option>
            <option value="b">{t("option")} B</option>
          </Select>
        </div>
      </div>
      <EmptyState title={t("empty_title")} description={t("empty_description")} />
    </div>
  );
  const table = (density: "comfortable" | "compact") => (
    <div data-density={density} className="space-y-2">
      <p className="text-sm font-medium">{t(`density_${density}`)}</p>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_order")}</TableHead>
                <TableHead>{t("col_status")}</TableHead>
                <TableHead className="text-right">{t("col_total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(["confirmed", "shipped", "delivered", "on_hold"] as const).map((s, i) => (
                <TableRow key={s}>
                  <TableCell className="font-medium">NW-{10421 + i}</TableCell>
                  <TableCell><StatusBadge status={s} /></TableCell>
                  <TableCell className="text-right">{money(8_990 + i * 4_250)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <section id="tokens" className="mb-8 space-y-3">
        <h2 className="text-lg">{t("tokens")}</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {THEMES.map((theme) => (
            <div key={theme} className={`${theme} rounded-xl border bg-background p-4 text-foreground`}>
              <p className="mb-3 text-sm font-semibold">{tt(theme)}</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {SWATCHES.map((k) => (
                  <div key={k} className="space-y-1">
                    <div className="h-10 rounded-md border" style={{ background: `var(--${k})` }} />
                    <p className="truncate text-[11px] font-medium">{k}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{TOKENS[theme][k]}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("type_note")}</p>
      </section>
      <section className="mb-8 space-y-3">
        <h2 className="text-lg">{t("components")}</h2>
        <div className="grid gap-4 xl:grid-cols-2">{THEMES.map((theme) => <div key={theme}>{sample(theme)}</div>)}</div>
      </section>
      <section className="mb-8 space-y-3">
        <h2 className="text-lg">{t("brand")}</h2>
        <p className="text-sm text-muted-foreground">{t("brand_description")}</p>
        <div className="grid gap-4 lg:grid-cols-3">
          {BRAND_SAMPLES.map((hex) => (
            <Card key={hex}>
              <CardHeader>
                <CardTitle className="font-mono text-sm">{hex}</CardTitle>
                <CardDescription>{t("brand_card")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {THEMES.map((theme) => {
                  const c = brandColorsFor(hex, BRAND_SURFACES[theme]);
                  return (
                    <div key={theme} className={`${theme} flex items-center gap-3 rounded-md border bg-card p-3 text-foreground`} style={brandStyle(c)}>
                      <Button size="sm">{t("primary")}</Button>
                      <span className="text-sm font-medium text-primary">{t("link")}</span>
                      <span className="ml-auto text-right font-mono text-[11px] text-muted-foreground">
                        {c.primary}
                        <br />
                        {contrastRatio(c.primary, c.onPrimary).toFixed(1)}:1{c.adjusted ? ` · ${t("adjusted")}` : ""}
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg">{t("density")}</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {table("comfortable")}
          {table("compact")}
        </div>
      </section>
    </>
  );
}

export default withIntl(StyleguidePage, "app/admin/styleguide/page.tsx");
