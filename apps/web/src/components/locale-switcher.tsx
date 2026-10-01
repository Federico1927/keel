"use client";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { SUPPORTED_LOCALES } from "@keel/config";
import { Select } from "@keel/ui";
import { setLocaleAction } from "@/i18n/locale-actions";

export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className={className}>
      <span className="sr-only">{t("language")}</span>
      <Select
        size="sm"
        aria-label={t("language")}
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          start(async () => {
            await setLocaleAction(next);
            router.refresh();
          });
        }}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {t(`locales.${l}`)}
          </option>
        ))}
      </Select>
    </label>
  );
}
