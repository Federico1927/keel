import { Suspense } from "react";
import { isWidgetVisible, type DashboardPeriod, type DashboardWidget, type TenantRole } from "@hullwise/config";
import { basesLookup, type WidgetEnv } from "@hullwise/services";
import { cn } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { loadWidget, pageNow, widgetEnv, widgetPeriod } from "@/server/dashboards";
import { WidgetSkeleton, WidgetView, type WidgetViewEnv } from "./widget-view";

const WIDTH: Record<number, string> = { 1: "", 2: "sm:col-span-2 lg:col-span-2", 3: "sm:col-span-2 lg:col-span-3", 4: "sm:col-span-2 lg:col-span-4" };
const HEIGHT: Record<number, string> = { 1: "", 2: "lg:row-span-2", 3: "lg:row-span-3", 4: "lg:row-span-4" };

async function Slot({ ctx, env, view, widget, periodKey }: { ctx: TenantContext; env: WidgetEnv; view: WidgetViewEnv; widget: DashboardWidget; periodKey: DashboardPeriod }) {
  const period = widgetPeriod(widget, periodKey, ctx.tenant.timezone, pageNow());
  const result = await loadWidget(ctx, env, widget, period);
  return <WidgetView widget={widget} result={result} period={period} env={view} />;
}

/**
 * A dashboard's widgets on a 4-column grid (2 on tablets, 1 on phones). Each widget is its own
 * Suspense boundary loading in its own transaction: they stream in parallel, a slow one never blocks
 * the page and a failed one renders an error tile. Widgets the viewer's role may not see are skipped.
 */
export async function DashboardGrid({ ctx, widgets, periodKey, role = ctx.role }: { ctx: TenantContext; widgets: DashboardWidget[]; periodKey: DashboardPeriod; role?: TenantRole }) {
  const env = await widgetEnv(ctx, role);
  const visible = widgets.filter((w) => isWidgetVisible(w, role, ctx.activeAddons, basesLookup(env.customs)));
  const view: WidgetViewEnv = { base: `/t/${ctx.tenant.slug}`, locale: ctx.locale, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, role, customs: env.customs };
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-flow-row-dense lg:grid-cols-4" data-testid="dashboard-grid">
      {visible.map((w) => (
        <div key={w.id} className={cn("min-w-0", WIDTH[w.w], HEIGHT[w.h], w.type === "sales_30d" && "lg:self-start")} data-widget={w.type} data-widget-id={w.id}>
          <Suspense fallback={<WidgetSkeleton widget={w} />}>
            <Slot ctx={ctx} env={env} view={view} widget={w} periodKey={periodKey} />
          </Suspense>
        </div>
      ))}
    </div>
  );
}
