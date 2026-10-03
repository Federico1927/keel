import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME, canDo, canViewPage } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { SPOKI_MODULE, listSpokiMessages } from "@hullwise/addon-spoki";
import { getCodSettings } from "@hullwise/addon-cod";
import type { ServiceContext } from "@hullwise/services";
import { and, eq, schema } from "@hullwise/db";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { WhatsappSimulate } from "./whatsapp-simulate";

/**
 * The answers a simulated customer gives to a COD confirmation: the store's first confirm and cancel
 * keywords (with `addon.cod`), so the simulated reply moves the COD queue whatever the viewer's language.
 */
export async function simulatedCodReplies(ctx: TenantContext, s: ServiceContext): Promise<string[]> {
  if (!ctx.activeAddons.includes("addon.cod")) return [];
  const r = (await getCodSettings(s)).messagingReplies;
  return [r.confirm[0], r.cancel[0]].filter((x): x is string => Boolean(x));
}

export const VARIANT: Record<string, "success" | "info" | "destructive" | "outline" | "muted" | "warning"> = { read: "success", replied: "success", delivered: "info", failed: "destructive", sent: "outline", queued: "warning", received: "muted" };

/**
 * WhatsApp message log (Spoki add-on, issue #9) of an order, a customer or the whole store: what was
 * sent and received, with the delivery status. Renders nothing without the add-on; in mock mode
 * integration managers can simulate Spoki's receipts and replies on each outbound message.
 */
export async function WhatsappLog({ ctx, orderId, customerId, limit = 30, title, description, excludePurposes, showEmpty = false }: { ctx: TenantContext; orderId?: string; customerId?: string; limit?: number; title?: string; description?: string; excludePurposes?: readonly string[]; showEmpty?: boolean }) {
  if (!ctx.activeAddons.includes(SPOKI_MODULE)) return null;
  const t = await getTranslations("whatsapp.log");
  const { rows, mock, codReplies } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [row] = await tx.select({ mode: schema.integrations.mode }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki"))).limit(1);
    return { rows: await listSpokiMessages(s, { orderId, customerId, limit, excludePurposes }), mock: integrationMode() === "mock" || row?.mode !== "live", codReplies: await simulatedCodReplies(ctx, s) };
  });
  if (!rows.length && !showEmpty) return null;
  const canSimulate = mock && canDo(ctx.role, "manage_integrations");
  const repliesFor = (purpose: string) => (purpose === "cod" && codReplies.length ? codReplies : [t("sample_question")]);
  const canOrders = canViewPage(ctx.role, "orders");
  const base = `/t/${ctx.tenant.slug}`;
  return (
    <Card data-testid="whatsapp-log">
      <CardHeader>
        <CardTitle className="text-base">{title ?? t("title")}</CardTitle>
        <CardDescription>{description ?? t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {rows.length === 0 ? (
          <p className="text-muted-foreground" data-testid="whatsapp-log-empty">{t("empty")}</p>
        ) : (
          <ol className="space-y-3">
            {rows.map(({ m, orderName, sender }) => (
              <li key={m.id} className={m.direction === "inbound" ? "rounded-md border-l-2 border-primary bg-muted/40 p-2" : "rounded-md border p-2"} data-testid="whatsapp-message" data-direction={m.direction} data-status={m.status}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium">{t.has(`purpose.${m.purpose}`) ? t(`purpose.${m.purpose}`, { product: PRODUCT_NAME }) : m.purpose}</span>
                  <Badge variant={VARIANT[m.status] ?? "outline"} data-testid="whatsapp-status">{t(`status.${m.status}`)}</Badge>
                  {m.templateName && <span className="font-mono text-muted-foreground">{m.templateName}</span>}
                  <span className="tabular text-muted-foreground">{formatDateTime(m.occurredAt, ctx.locale, ctx.tenant.timezone)}</span>
                  {orderName && !orderId && m.orderId && (canOrders ? <Link href={`${base}/orders/${m.orderId}`} className="underline-offset-4 hover:underline">{orderName}</Link> : <span>{orderName}</span>)}
                  {sender && <span className="text-muted-foreground">· {sender}</span>}
                  {canSimulate && m.direction === "outbound" && m.providerMessageId && m.status !== "failed" && <span className="ml-auto"><WhatsappSimulate slug={ctx.tenant.slug} messageId={m.providerMessageId} replies={repliesFor(m.purpose)} /></span>}
                </div>
                {m.body && m.body !== m.purpose && <p className="mt-1 whitespace-pre-line break-words text-sm">{m.body}</p>}
                {m.status === "failed" && (m.errorMessage || m.errorCode) && <p className="mt-1 text-xs text-destructive">{m.errorCode ? `${m.errorCode} · ` : ""}{m.errorMessage ?? ""}</p>}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
