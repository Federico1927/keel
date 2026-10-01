"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Copy, Play, RefreshCw } from "lucide-react";
import { Button, Input, Label } from "@keel/ui";
import { runConversionsNowAction, saveConversionSettingsAction, savePixelSettingsAction, sendTestPixelEventAction } from "@/server/actions/tracking";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setDone(r.ok);
      setError(r.ok ? null : (r.error ?? "error"));
      if (r.ok) router.refresh();
    });
  return { pending, error, done, act };
}

export function CopyBlock({ code, testId }: { code: string; testId: string }) {
  const t = useTranslations("tracking");
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs" data-testid={testId}>{code}</pre>
      <Button type="button" size="sm" variant="outline" className="absolute right-2 top-2" onClick={() => { void navigator.clipboard?.writeText(code); setCopied(true); }}>
        <Copy /> {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

export function PixelControls({ slug, enabled, allowedOrigins, lookbackDays, canManage }: { slug: string; enabled: boolean; allowedOrigins: string[]; lookbackDays: number; canManage: boolean }) {
  const t = useTranslations("tracking");
  const tc = useTranslations("common");
  const { pending, error, act } = useAct();
  const [on, setOn] = useState(enabled);
  const [origins, setOrigins] = useState(allowedOrigins.join("\n"));
  const [days, setDays] = useState(lookbackDays);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act(() => savePixelSettingsAction(slug, { enabled: on, allowedOrigins: origins, lookbackDays: days })); }}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={on} disabled={!canManage} onChange={(e) => setOn(e.target.checked)} /> {t("pixel.enabled")}</label>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="space-y-1">
          <Label htmlFor="px-origins">{t("pixel.origins")}</Label>
          <textarea id="px-origins" className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" value={origins} disabled={!canManage} onChange={(e) => setOrigins(e.target.value)} placeholder="https://shop.example.com" />
          <p className="text-xs text-muted-foreground">{t("pixel.origins_help")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="px-lookback">{t("pixel.lookback")}</Label>
          <Input id="px-lookback" type="number" min={1} max={90} value={days} disabled={!canManage} onChange={(e) => setDays(Number(e.target.value))} />
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{tc.has(`errors.${error}`) ? tc(`errors.${error}`) : error}</p>}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>{tc("save")}</Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => act(() => sendTestPixelEventAction(slug))} data-testid="pixel-test"><Play /> {t("pixel.test_event")}</Button>
        </div>
      )}
    </form>
  );
}

export function ConversionForm({ slug, provider, value, canManage }: { slug: string; provider: "meta" | "google"; value: { enabled: boolean; destinationId: string | null; testEventCode: string | null; requireConsent: boolean; lookbackDays: number }; canManage: boolean }) {
  const t = useTranslations("tracking");
  const tc = useTranslations("common");
  const { pending, error, done, act } = useAct();
  const [v, setV] = useState({ ...value, destinationId: value.destinationId ?? "", testEventCode: value.testEventCode ?? "" });
  return (
    <form className="space-y-3" data-testid={`conversions-${provider}`} onSubmit={(e) => { e.preventDefault(); act(() => saveConversionSettingsAction(slug, { provider, ...v })); }}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.enabled} disabled={!canManage} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> {t(`conversions.enable_${provider}`)}</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`cv-${provider}-dest`}>{t(`conversions.destination_${provider}`)}</Label>
          <Input id={`cv-${provider}-dest`} value={v.destinationId} disabled={!canManage} onChange={(e) => setV({ ...v, destinationId: e.target.value })} />
        </div>
        {provider === "meta" ? (
          <div className="space-y-1">
            <Label htmlFor="cv-meta-test">{t("conversions.test_code")}</Label>
            <Input id="cv-meta-test" value={v.testEventCode} disabled={!canManage} onChange={(e) => setV({ ...v, testEventCode: e.target.value })} placeholder="TEST12345" />
          </div>
        ) : (
          <div />
        )}
        <div className="space-y-1">
          <Label htmlFor={`cv-${provider}-days`}>{t("conversions.lookback", { max: provider === "meta" ? 7 : 90 })}</Label>
          <Input id={`cv-${provider}-days`} type="number" min={1} max={provider === "meta" ? 7 : 90} value={v.lookbackDays} disabled={!canManage} onChange={(e) => setV({ ...v, lookbackDays: Number(e.target.value) })} />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={v.requireConsent} disabled={!canManage} onChange={(e) => setV({ ...v, requireConsent: e.target.checked })} /> {t("conversions.require_consent")}</label>
      </div>
      {error && <p className="text-sm text-destructive">{tc.has(`errors.${error}`) ? tc(`errors.${error}`) : t(`errors.${error}`)}</p>}
      {done && !error && <p className="text-sm text-muted-foreground">{t("saved")}</p>}
      {canManage && <Button type="submit" disabled={pending}>{tc("save")}</Button>}
    </form>
  );
}

export function RunConversions({ slug }: { slug: string }) {
  const t = useTranslations("tracking");
  const { pending, act } = useAct();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => runConversionsNowAction(slug, false))} data-testid="conversions-run"><Play /> {t("conversions.run_now")}</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => runConversionsNowAction(slug, true))}><RefreshCw /> {t("conversions.retry_failed")}</Button>
    </div>
  );
}
