import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WifiOff } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { RetryButton } from "./retry";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("mobile.pwa"))("offline_title") };
}

/** Offline screen (#49): precached by the service worker and shown when a page cannot load. No tenant data. */
export default async function OfflinePage() {
  const t = await getTranslations("mobile.pwa");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <BrandMark className="h-10 w-10" />
      <WifiOff className="h-8 w-8 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">{t("offline_title")}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t("offline_body")}</p>
      <RetryButton label={t("retry")} />
    </main>
  );
}
