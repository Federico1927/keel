import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatNumber } from "@hullwise/core";
import { fulfilmentBoard, parseBoardFilters, shipmentCaseCounts } from "@hullwise/services";
import { Button, Input, PageHeader, Stat, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { FulfilmentTabs } from "./tabs";
import { Board } from "./board";

import { withIntl } from "@/i18n/intl-scope";
/** Late-to-ship queue and pick/pack board (pending → packed → shipped), issue #28. */
async function FulfilmentPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "shipments");
  const t = await getTranslations("fulfilment");
  const filters = parseBoardFilters(await searchParams);
  const clock = { timezone: ctx.tenant.timezone, settings: ctx.settings };
  const { board, cases } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { board: await fulfilmentBoard(s, clock, filters), cases: await shipmentCaseCounts(s) };
  });
  const base = `/t/${tenant}/fulfilment`;
  const n = (v: number) => formatNumber(v, ctx.locale);
  const href = (view: "all" | "late") => `${base}${view === "late" ? "?view=late" : ""}${filters.q ? `${view === "late" ? "&" : "?"}q=${encodeURIComponent(filters.q)}` : ""}`;
  const serial = <T extends { placedAt: Date; packedAt: Date | null }>(c: T) => ({ ...c, placedAt: c.placedAt.toISOString(), packedAt: c.packedAt?.toISOString() ?? null });
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description", { days: board.thresholdDays })} />
      <FulfilmentTabs slug={tenant} active="board" counts={{ toShip: board.counts.all, exceptions: cases.exceptionsOpen, returned: cases.rtsOpen }} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("kpi.late", { days: board.thresholdDays })} value={n(board.counts.late)} href={href("late")} className={board.counts.late ? "border-destructive/40" : ""} />
        <Stat label={t("kpi.to_pack")} value={n(board.counts.pending)} href={href("all")} />
        <Stat label={t("kpi.packed")} value={n(board.counts.packed)} href={href("all")} />
        <Stat label={t("kpi.shipped_today")} value={n(board.counts.shippedToday)} />
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("views.label")}>
          {(["all", "late"] as const).map((v) => (
            <Link key={v} href={href(v)} data-testid={`view-${v}`} className={cn("rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9 pointer-coarse:py-2", filters.view === v ? "bg-primary text-primary-foreground" : "bg-card")}>
              {t(`views.${v}`)}
            </Link>
          ))}
          <span className="self-center text-xs text-muted-foreground">{t("threshold", { days: board.thresholdDays, tz: ctx.tenant.timezone })}</span>
        </div>
        <form className="flex gap-2" action={base}>
          {filters.view === "late" && <input type="hidden" name="view" value="late" />}
          <Input type="search" enterKeyHint="search" name="q" defaultValue={filters.q ?? ""} placeholder={t("search_placeholder")} aria-label={t("search")} className="sm:w-64" />
          <Button type="submit" variant="outline">{t("search")}</Button>
        </form>
      </div>
      <Board
        slug={tenant}
        canWrite={canWritePage(ctx.role, "shipments")}
        locale={ctx.locale}
        timezone={ctx.tenant.timezone}
        view={filters.view}
        pending={board.pending.map(serial)}
        packed={board.packed.map(serial)}
        shipped={board.shipped.map((s) => ({ ...s, shippedAt: s.shippedAt?.toISOString() ?? null }))}
        totals={{ pending: board.filtered.pending, packed: board.filtered.packed, shipped: board.counts.shippedToday }}
      />
    </>
  );
}

export default withIntl(FulfilmentPage, "app/t/[tenant]/fulfilment/page.tsx");
