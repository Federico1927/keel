"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { setGoogleWriteAccess } from "@/server/actions/ads";

/** Google Ads stays read-only until the tenant confirms it granted the write scope (pause ads, negative keywords). */
export function GoogleWriteAccessToggle({ slug, enabled, canManage }: { slug: string; enabled: boolean; canManage: boolean }) {
  const t = useTranslations("integrations");
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  return (
    <label className="flex items-start gap-2 text-xs" data-testid="google-write-access">
      <input type="checkbox" className="mt-0.5" checked={on} disabled={!canManage || pending} onChange={(e) => { const next = e.target.checked; setOn(next); start(async () => { const r = await setGoogleWriteAccess(slug, next); if (!r.ok) setOn(!next); }); }} />
      <span>{t("google_write_access")}<br /><span className="text-muted-foreground">{t("google_write_access_hint")}</span></span>
    </label>
  );
}
