import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@hullwise/ui";

const TABS = [
  { key: "list", path: "" },
  { key: "rfm", path: "/rfm" },
  { key: "predictions", path: "/predictions" },
] as const;

export async function CustomerTabs({ tenant, active }: { tenant: string; active: (typeof TABS)[number]["key"] }) {
  const t = await getTranslations("customers");
  const base = `/t/${tenant}/customers`;
  return (
    <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
      {TABS.map((tab) => (
        <Link key={tab.key} href={`${base}${tab.path}`} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", tab.key === active ? "bg-card shadow-sm" : "text-muted-foreground")}>
          {t(`tabs.${tab.key}`)}
        </Link>
      ))}
    </div>
  );
}
