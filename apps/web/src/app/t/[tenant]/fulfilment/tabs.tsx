import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@hullwise/ui";

/** Sub-navigation of the fulfilment area: board, exception queue, return-to-sender review. */
export async function FulfilmentTabs({ slug, active, counts }: { slug: string; active: "board" | "exceptions" | "returned"; counts: { toShip: number; exceptions: number; returned: number } }) {
  const t = await getTranslations("fulfilment.tabs");
  const tabs = [
    { key: "board" as const, href: `/t/${slug}/fulfilment`, n: counts.toShip },
    { key: "exceptions" as const, href: `/t/${slug}/fulfilment/exceptions`, n: counts.exceptions },
    { key: "returned" as const, href: `/t/${slug}/fulfilment/returned`, n: counts.returned },
  ];
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b" aria-label={t("label")}>
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} data-testid={`fulfilment-tab-${tab.key}`} aria-current={active === tab.key ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm", active === tab.key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {t(tab.key)} <span className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular">{tab.n}</span>
        </Link>
      ))}
    </nav>
  );
}
