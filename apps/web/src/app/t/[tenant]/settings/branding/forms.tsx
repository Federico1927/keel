"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { brandColorsFor, isHexColor } from "@keel/core";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@keel/ui";
import { BRAND_SURFACES, TOKENS } from "@keel/ui/tokens";
import { ImageUpload } from "@/components/image-upload";
import type { ActionResult } from "@/server/action-result";
import { removeBrandLogoAction, saveBrandColorAction, uploadBrandLogoAction } from "@/server/actions/branding";

/** A themed sample: the same markup on a forced light or dark token set, with the brand variables applied. */
function Sample({ theme, primary, onPrimary, label, link }: { theme: "light" | "dark"; primary: string; onPrimary: string; label: string; link: string }) {
  const tt = useTranslations("theme");
  return (
    <div className={`${theme} rounded-lg border bg-card p-4 text-foreground`} style={{ ["--primary" as string]: primary, ["--on-primary" as string]: onPrimary }} data-testid={`brand-sample-${theme}`}>
      <p className="mb-3 text-xs text-muted-foreground">{tt(theme)} · <span className="font-mono">{primary}</span></p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm">{label}</Button>
        <span className="text-sm font-medium text-primary underline-offset-4 hover:underline">{link}</span>
        <span className="inline-flex h-4 w-7 items-center rounded-full bg-primary p-0.5"><span className="ml-auto h-3 w-3 rounded-full bg-primary-foreground" /></span>
      </div>
    </div>
  );
}

export function BrandingForm({ slug, tenantName, canEdit, brandColor, logoLight, logoDark }: { slug: string; tenantName: string; canEdit: boolean; brandColor: string | null; logoLight: string | null; logoDark: string | null }) {
  const t = useTranslations("branding");
  const router = useRouter();
  const [color, setColor] = useState(brandColor ?? "");
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionResult | null>(null);
  const valid = color === "" || isHexColor(color);
  const effective = isHexColor(color) ? color : null;
  const light = useMemo(() => (effective ? brandColorsFor(effective, BRAND_SURFACES.light) : { primary: TOKENS.light.primary, onPrimary: TOKENS.light["on-primary"], adjusted: false }), [effective]);
  const dark = useMemo(() => (effective ? brandColorsFor(effective, BRAND_SURFACES.dark) : { primary: TOKENS.dark.primary, onPrimary: TOKENS.dark["on-primary"], adjusted: false }), [effective]);
  const save = (value: string | null) =>
    start(async () => {
      const r = await saveBrandColorAction(slug, value);
      setState(r);
      if (r.ok) router.refresh();
    });
  const logoAction = (variant: "light" | "dark") => async (prev: ActionResult | null, fd: FormData) => {
    const r = await uploadBrandLogoAction(slug, variant, prev, fd);
    if (r.ok) router.refresh();
    return r;
  };
  const removeLogo = (variant: "light" | "dark") => async () => {
    const r = await removeBrandLogoAction(slug, variant);
    if (r.ok) router.refresh();
    return r;
  };
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("color")}</CardTitle>
          <CardDescription>{t("color_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="brand-color">{t("color_hex")}</Label>
              <div className="flex items-center gap-2">
                <input type="color" aria-label={t("color_picker")} value={effective ?? TOKENS.light.primary} disabled={!canEdit} onChange={(e) => setColor(e.target.value)} className="h-10 w-12 cursor-pointer rounded-md border border-input bg-card p-1" />
                <Input id="brand-color" value={color} placeholder={TOKENS.light.primary} disabled={!canEdit} onChange={(e) => setColor(e.target.value.trim())} className="w-32 font-mono" aria-invalid={!valid} data-testid="brand-color" />
              </div>
            </div>
            {canEdit && (
              <>
                <Button type="button" disabled={pending || !valid} onClick={() => save(effective)} data-testid="brand-save">{t("save")}</Button>
                <Button type="button" variant="ghost" disabled={pending || !brandColor} onClick={() => { setColor(""); save(null); }}>{t("reset")}</Button>
              </>
            )}
          </div>
          {!valid && <p className="text-xs text-destructive">{t("invalid_color")}</p>}
          {(light.adjusted || dark.adjusted) && (
            <Alert variant="info" data-testid="brand-adjusted">
              <AlertDescription>{t("adjusted", { light: light.primary, dark: dark.primary })}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Sample theme="light" primary={light.primary} onPrimary={light.onPrimary} label={t("sample_button")} link={t("sample_link")} />
            <Sample theme="dark" primary={dark.primary} onPrimary={dark.onPrimary} label={t("sample_button")} link={t("sample_link")} />
          </div>
          {state && (state.ok ? <p className="text-sm text-success" role="status">{t("saved")}</p> : <p className="text-sm text-destructive" role="alert">{t(`errors.${state.error === "invalid_color" ? "invalid_color" : "generic"}`)}</p>)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("logos")}</CardTitle>
          <CardDescription>{t("logos_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {(["light", "dark"] as const).map((variant) => {
            const src = variant === "light" ? logoLight : logoDark;
            return (
              <div key={variant} className="space-y-2">
                <p className="text-sm font-medium">{t(`logo_${variant}`)}</p>
                <div className={`${variant} flex h-16 items-center rounded-md border bg-card px-4`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img src={src} alt={tenantName} className="h-8 max-w-[14rem] object-contain" /> : <span className="text-sm text-muted-foreground">{variant === "dark" && logoLight ? t("logo_dark_fallback") : t("logo_none")}</span>}
                </div>
                {canEdit && <ImageUpload field="logo" action={logoAction(variant)} onRemove={removeLogo(variant)} hasImage={variant === "light" ? Boolean(logoLight) : Boolean(logoDark) && logoDark !== logoLight} label={t("logo_upload")} removeLabel={t("logo_remove")} testId={`logo-${variant}-input`} />}
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">{t("used_by")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
