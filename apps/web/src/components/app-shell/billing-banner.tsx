import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AlertTriangle } from "lucide-react";
import { PRODUCT_NAME } from "@hullwise/config";
import type { BillingBanner as Banner } from "@hullwise/services";

/** Owners only (#53): a past-due balance or a payment to authenticate, with Stripe's payment link and the billing page. */
export async function BillingBanner({ banner, slug }: { banner: Banner; slug: string }) {
  const t = await getTranslations("billing.banner");
  const action = banner.kind === "action_required";
  return (
    <div role="alert" data-testid="billing-banner" data-kind={banner.kind} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm ${action ? "bg-warning/15 text-foreground" : "bg-destructive/15 text-foreground"}`}>
      <AlertTriangle className={`h-4 w-4 shrink-0 ${action ? "text-warning" : "text-destructive"}`} />
      <span className="min-w-0 flex-1">{action ? t("action_required") : t("past_due", { product: PRODUCT_NAME })}{banner.suspendsInDays !== null && ` ${t("past_due_days", { n: banner.suspendsInDays })}`}</span>
      {banner.payUrl && <a href={banner.payUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">{action ? t("confirm") : t("pay")}</a>}
      <Link href={`/t/${slug}/settings/billing`} className="font-medium underline underline-offset-2">{t("details")}</Link>
    </div>
  );
}
