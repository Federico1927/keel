"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Select } from "@keel/ui";

export function CampaignFilters({ basePath, keep, platform, status, platforms }: { basePath: string; keep: Record<string, string | undefined>; platform?: string; status?: string; platforms: readonly string[] }) {
  const t = useTranslations("campaigns");
  const router = useRouter();
  const go = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, platform, status, ...patch })) if (v) u.set(k, v);
    router.push(`${basePath}?${u}`);
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Select size="sm" aria-label={t("columns.platform")} value={platform ?? ""} onChange={(e) => go({ platform: e.target.value || undefined })} className="w-40">
        <option value="">{t("all_platforms")}</option>
        {platforms.map((p) => <option key={p} value={p}>{t(`platform.${p}`)}</option>)}
      </Select>
      <Select size="sm" aria-label={t("columns.status")} value={status ?? ""} onChange={(e) => go({ status: e.target.value || undefined })} className="w-40">
        <option value="">{t("all_statuses")}</option>
        {["active", "paused", "archived"].map((s) => (
          <option key={s} value={s}>{t(`status.${s}`)}</option>
        ))}
      </Select>
    </div>
  );
}
