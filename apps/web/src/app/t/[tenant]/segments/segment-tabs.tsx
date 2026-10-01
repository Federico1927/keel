import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { isPageEnabled } from "@keel/config";
import { cn } from "@keel/ui";

/** Segments | Campaigns. Without the customer-campaigns add-on there is a single page and no tabs. */
export async function SegmentTabs({ tenant, active, activeAddons }: { tenant: string; active: "segments" | "campaigns"; activeAddons: readonly string[] }) {
  if (!isPageEnabled("customer_campaigns", activeAddons)) return null;
  const t = await getTranslations("retention");
  const base = `/t/${tenant}/segments`;
  return (
    <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
      <Link href={base} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", active === "segments" ? "bg-card shadow-sm" : "text-muted-foreground")}>{t("tabs.segments")}</Link>
      <Link href={`${base}/campaigns`} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", active === "campaigns" ? "bg-card shadow-sm" : "text-muted-foreground")}>{t("tabs.campaigns")}</Link>
    </div>
  );
}
