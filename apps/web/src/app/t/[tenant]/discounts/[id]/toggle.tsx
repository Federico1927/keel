"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@keel/ui";
import { setDiscountActiveAction } from "@/server/actions/discounts";

export function DiscountToggle({ slug, discountId, isActive }: { slug: string; discountId: string; isActive: boolean }) {
  const t = useTranslations("discount_detail");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant={isActive ? "outline" : "default"} disabled={pending} onClick={() => start(async () => { await setDiscountActiveAction(slug, discountId, !isActive); router.refresh(); })}>
      {isActive ? t("disable") : t("enable")}
    </Button>
  );
}
