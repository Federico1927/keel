"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import { openBillingPortalAction } from "@/server/actions/billing";

/** "Manage payment method" (#53): a Stripe Customer Portal session, opened in this tab. */
export function PortalButton({ slug }: { slug: string }) {
  const t = useTranslations("billing");
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button disabled={pending} data-testid="manage-payment" onClick={() => start(async () => { const r = await openBillingPortalAction(slug); if (r && !r.ok) setError(true); })}>{t("manage_payment")}</Button>
      {error && <span className="text-sm text-destructive" role="alert">{t("portal_error")}</span>}
    </span>
  );
}
