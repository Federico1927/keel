"use client";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Avatar, Button, Input, Label, Select } from "@keel/ui";
import { SUPPORTED_LOCALES } from "@keel/config";
import type { ActionResult } from "@/server/action-result";
import { ImageUpload } from "@/components/image-upload";
import {
  cancelEmailChangeAction,
  changePasswordAction,
  removeAvatarAction,
  requestEmailChangeAction,
  signOutOtherSessionsAction,
  updatePreferencesAction,
  updateProfileAction,
  uploadAvatarAction,
} from "@/server/actions/profile";

function Result({ state, okKey }: { state: ActionResult | null; okKey?: string }) {
  const t = useTranslations("profile");
  if (!state) return null;
  if (state.ok) return okKey ? <p className="text-sm text-success" role="status">{t(okKey)}</p> : null;
  const issues = state.fieldErrors ? Object.keys(state.fieldErrors) : [];
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {t(`errors.${state.error}`)}
        {issues.length > 0 && (
          <ul className="mt-1 list-disc pl-4">
            {issues.map((i) => (
              <li key={i}>{t(`password_issues.${i}`)}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Refreshes the server-rendered shell (header name, greeting, theme) after a successful save. */
function useRefreshOnOk(state: ActionResult | null) {
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
}

export function IdentityForm({ values }: { values: { name: string; preferredName: string; jobTitle: string } }) {
  const t = useTranslations("profile");
  const [state, action, pending] = useActionState(updateProfileAction, null);
  useRefreshOnOk(state);
  return (
    <form action={action} className="space-y-4" data-testid="identity-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-name">{t("name")}</Label>
          <Input id="p-name" name="name" required maxLength={120} defaultValue={values.name} autoComplete="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-preferred">{t("preferred_name")}</Label>
          <Input id="p-preferred" name="preferredName" maxLength={60} defaultValue={values.preferredName} autoComplete="nickname" />
          <p className="text-xs text-muted-foreground">{t("preferred_name_hint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-title">{t("job_title")}</Label>
          <Input id="p-title" name="jobTitle" maxLength={80} defaultValue={values.jobTitle} autoComplete="organization-title" />
        </div>
      </div>
      <Result state={state} okKey="saved" />
      <Button type="submit" disabled={pending}>{t("save")}</Button>
    </form>
  );
}

export function AvatarField({ name, initials, avatarUrl }: { name: string; initials: string; avatarUrl: string | null }) {
  const t = useTranslations("profile");
  const router = useRouter();
  const upload = async (prev: ActionResult | null, fd: FormData) => {
    const r = await uploadAvatarAction(prev, fd);
    if (r.ok) router.refresh();
    return r;
  };
  const remove = async () => {
    const r = await removeAvatarAction();
    if (r.ok) router.refresh();
    return r;
  };
  return (
    <div className="flex items-center gap-4">
      <Avatar src={avatarUrl} initials={initials} alt={name} size="lg" />
      <ImageUpload field="avatar" action={upload} onRemove={remove} hasImage={Boolean(avatarUrl)} label={avatarUrl ? t("photo_change") : t("photo_upload")} removeLabel={t("photo_remove")} maxSide={768} testId="avatar-input" />
    </div>
  );
}

export function PreferencesForm({ tenantSlug, values, timeZones, tenantTimeZone, tenantLocaleLabel }: { tenantSlug: string | null; values: { locale: string; theme: string; density: string; timeZone: string }; timeZones: string[]; tenantTimeZone: string | null; tenantLocaleLabel: string | null }) {
  const t = useTranslations("profile");
  const tc = useTranslations("common");
  const tt = useTranslations("theme");
  const [state, action, pending] = useActionState(updatePreferencesAction.bind(null, tenantSlug), null);
  useRefreshOnOk(state);
  return (
    <form action={action} className="space-y-4" data-testid="preferences-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-locale">{tc("language")}</Label>
          <Select id="p-locale" name="locale" defaultValue={values.locale}>
            <option value="">{tenantLocaleLabel ? t("locale_default_named", { language: tenantLocaleLabel }) : t("locale_default")}</option>
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l} value={l}>{tc(`locales.${l}`)}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-tz">{t("time_zone")}</Label>
          <Select id="p-tz" name="timeZone" defaultValue={values.timeZone}>
            <option value="">{tenantTimeZone ? t("time_zone_default_named", { zone: tenantTimeZone }) : t("time_zone_default")}</option>
            {timeZones.map((z) => (
              <option key={z} value={z}>{z.replaceAll("_", " ")}</option>
            ))}
          </Select>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">{tt("label")}</legend>
          <div className="inline-flex rounded-md border bg-muted p-0.5" role="radiogroup">
            {(["light", "dark", "system"] as const).map((v) => (
              <label key={v} className="cursor-pointer">
                <input type="radio" name="theme" value={v} defaultChecked={values.theme === v} className="peer sr-only" />
                <span className="block rounded-[0.3rem] px-3 py-1.5 text-sm text-muted-foreground peer-checked:bg-card peer-checked:font-medium peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring">{tt(v)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">{t("density")}</legend>
          <div className="inline-flex rounded-md border bg-muted p-0.5" role="radiogroup">
            {(["comfortable", "compact"] as const).map((v) => (
              <label key={v} className="cursor-pointer">
                <input type="radio" name="density" value={v} defaultChecked={values.density === v} className="peer sr-only" />
                <span className="block rounded-[0.3rem] px-3 py-1.5 text-sm text-muted-foreground peer-checked:bg-card peer-checked:font-medium peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring">{t(`density_${v}`)}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("density_hint")}</p>
        </fieldset>
      </div>
      <p className="text-xs text-muted-foreground">{t("format_hint")}</p>
      <Result state={state} okKey="saved" />
      <Button type="submit" disabled={pending}>{t("save")}</Button>
    </form>
  );
}

export function PasswordForm() {
  const t = useTranslations("profile");
  const [state, action, pending] = useActionState(changePasswordAction, null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (state?.ok) setKey((k) => k + 1);
  }, [state]);
  return (
    <form key={key} action={action} className="space-y-3" data-testid="password-form">
      <div className="space-y-1.5">
        <Label htmlFor="pw-current">{t("password_current")}</Label>
        <Input id="pw-current" name="current" type="password" required autoComplete="current-password" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pw-next">{t("password_new")}</Label>
          <Input id="pw-next" name="next" type="password" required minLength={10} autoComplete="new-password" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-confirm">{t("password_confirm")}</Label>
          <Input id="pw-confirm" name="confirm" type="password" required autoComplete="new-password" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("password_hint")}</p>
      <Result state={state} okKey="password_changed" />
      <Button type="submit" variant="outline" disabled={pending}>{t("password_submit")}</Button>
    </form>
  );
}

export function EmailForm({ email, pending: pendingEmail }: { email: string; pending: string | null }) {
  const t = useTranslations("profile");
  const [state, action, busy] = useActionState(requestEmailChangeAction, null);
  const [cancelling, start] = useTransition();
  const router = useRouter();
  useRefreshOnOk(state);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {t("email_current")} <span className="font-medium" data-testid="profile-email">{email}</span>
      </p>
      {pendingEmail && (
        <Alert variant="info" data-testid="email-pending">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("email_pending", { email: pendingEmail })}</span>
            <Button type="button" size="sm" variant="ghost" disabled={cancelling} onClick={() => start(async () => { await cancelEmailChangeAction(); router.refresh(); })}>{t("email_cancel")}</Button>
          </AlertDescription>
        </Alert>
      )}
      <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end" data-testid="email-form">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="em-new">{t("email_new")}</Label>
          <Input id="em-new" name="email" type="email" required autoComplete="email" />
        </div>
        <Button type="submit" variant="outline" disabled={busy}>{t("email_submit")}</Button>
      </form>
      <p className="text-xs text-muted-foreground">{t("email_hint")}</p>
      <Result state={state} okKey="email_sent" />
    </div>
  );
}

export function SignOutOthersButton() {
  const t = useTranslations("profile");
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionResult | null>(null);
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" disabled={pending} onClick={() => start(async () => setState(await signOutOtherSessionsAction()))} data-testid="sign-out-others">
        {t("sessions_sign_out_others")}
      </Button>
      <Result state={state} okKey="sessions_signed_out" />
    </div>
  );
}
