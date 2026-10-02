"use client";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, Checkbox, Input, Label, cn } from "@keel/ui";
import type { ActionResult } from "@/server/action-result";
import { NewPasswordFields } from "@/components/account/password-fields";
import { AccountErrorMessage } from "@/components/account/error-message";
import { acceptInvitationAction, acceptInvitationAsUserAction, signOutAndReturnAction } from "@/server/actions/account";

export function AcceptInvitationForm({ token, email, name, privacyUrl }: { token: string; email: string; name: string | null; privacyUrl: string | null }) {
  const t = useTranslations("account");
  const tp = useTranslations("profile");
  const [state, action, pending] = useActionState(acceptInvitationAction.bind(null, token), null);
  const [method, setMethod] = useState<"password" | "email_link">("password");
  const [fullName, setFullName] = useState(name ?? "");
  return (
    <form action={action} className="space-y-4" data-testid="accept-form">
      <p className="text-sm">
        {t("invite_email")} <span className="font-medium" data-testid="invite-email">{email}</span>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="inv-name">{tp("name")}</Label>
        <Input id="inv-name" name="name" required maxLength={120} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="inv-preferred">{tp("preferred_name")}</Label>
        <Input id="inv-preferred" name="preferredName" maxLength={60} autoComplete="nickname" />
        <p className="text-xs text-muted-foreground">{tp("preferred_name_hint")}</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium">{t("invite_method")}</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          {(["password", "email_link"] as const).map((m) => (
            <label key={m} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm", method === m && "border-primary bg-muted")}>
              <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} className="mt-0.5 accent-[var(--primary)]" />
              <span>
                <span className="block font-medium">{t(`invite_method_${m}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`invite_method_${m}_hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {method === "password" && <NewPasswordFields email={email} name={fullName} />}
      <div className="flex items-start gap-2">
        <Checkbox id="inv-privacy" name="privacy" required className="mt-0.5" />
        <Label htmlFor="inv-privacy" className="text-sm font-normal leading-snug">
          {privacyUrl ? (
            t.rich("invite_privacy_link", { link: (chunks) => <a href={privacyUrl} target="_blank" rel="noreferrer" className="font-medium text-primary underline">{chunks}</a> })
          ) : (
            t("invite_privacy")
          )}
        </Label>
      </div>
      {state && !state.ok && <AccountErrorMessage state={state} />}
      <Button type="submit" className="w-full" disabled={pending} data-testid="accept-submit">
        {t("invite_accept")}
      </Button>
    </form>
  );
}

export function AcceptAsUserButton({ token, tenantName }: { token: string; tenantName: string }) {
  const t = useTranslations("account");
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionResult | null>(null);
  return (
    <div className="space-y-3">
      {state && !state.ok && <AccountErrorMessage state={state} />}
      <Button className="w-full" disabled={pending} data-testid="accept-existing" onClick={() => start(async () => setState(await acceptInvitationAsUserAction(token)))}>
        {t("invite_join", { tenant: tenantName })}
      </Button>
    </div>
  );
}

export function SignOutAndReturnButton({ next }: { next: string }) {
  const t = useTranslations("account");
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" className="mt-4 w-full" disabled={pending} onClick={() => start(async () => { await signOutAndReturnAction(next); })}>
      {t("invite_switch_account")}
    </Button>
  );
}
