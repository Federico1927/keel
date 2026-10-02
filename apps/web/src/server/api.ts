import { adminDb, appDb, withTenant } from "@hullwise/db";
import { executePlatformWrite, webhookUrlPolicy, type ApiHttpDeps, type ServiceContext, type TenantRunner } from "@hullwise/services";
import { enqueue } from "./jobs";
import "./webhooks";

/**
 * Web side of the public REST API (#81): database connections, the SSRF policy of this process and
 * the dispatch of platform writes a request enqueued (stock adjustments), like the UI's actions:
 * the worker when deployed, inline otherwise.
 */
export function apiDeps(): ApiHttpDeps {
  return {
    admin: adminDb(),
    app: appDb(),
    policy: webhookUrlPolicy(),
    async onPlatformWrites(tenant, writes) {
      for (const w of writes) {
        if (w.mode !== "async" || w.status !== "pending") continue;
        if (await enqueue("platform.write", { tenantId: tenant.id, writeId: w.id }, { singletonKey: w.id })) continue;
        const run: TenantRunner = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenant.id, (tx) => fn({ tenantId: tenant.id, tx, actor: { type: "system", userId: null } }));
        await executePlatformWrite(run, tenant, w.id);
      }
    },
  };
}
