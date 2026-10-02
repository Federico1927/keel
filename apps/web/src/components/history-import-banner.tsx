import { getTranslations } from "next-intl/server";
import { formatNumber } from "@hullwise/core";
import { historyImportStatus } from "@hullwise/services";
import type { TenantContext } from "@/server/tenant";

/**
 * Says that the store's order history is still being imported (issue #87), above the pages whose
 * numbers depend on it: until the first import completes, past periods, cohorts and customer
 * history are incomplete. Nothing when the import is done or was never started (demo stores).
 */
export async function HistoryImportBanner({ ctx }: { ctx: TenantContext }) {
  const h = await ctx.run((tx) => historyImportStatus({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  if (h.state === "done" || h.state === "not_started") return null;
  const t = await getTranslations("integrations.history_import");
  return (
    <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="history-import-banner" data-state={h.state}>
      {t(h.state === "error" ? "banner_error" : "banner", { n: formatNumber(h.ordersImported, ctx.locale) })}
    </p>
  );
}
