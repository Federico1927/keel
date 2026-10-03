import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@hullwise/ui";

/** Conversations | Settings of the WhatsApp (Spoki) add-on. */
export async function WhatsappTabs({ tenant, active }: { tenant: string; active: "conversations" | "settings" }) {
  const t = await getTranslations("whatsapp.tabs");
  const base = `/t/${tenant}/whatsapp`;
  const tab = (key: "conversations" | "settings", href: string) => <Link href={href} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", active === key ? "bg-card shadow-sm" : "text-muted-foreground")} aria-current={active === key ? "page" : undefined} data-testid={`whatsapp-tab-${key}`}>{t(key)}</Link>;
  return <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">{tab("conversations", base)}{tab("settings", `${base}/settings`)}</div>;
}
