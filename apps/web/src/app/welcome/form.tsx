"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label } from "@keel/ui";
import { completeProfileAction } from "@/server/actions/profile";

export function CompleteProfileForm({ next }: { next: string }) {
  const t = useTranslations("welcome");
  const tp = useTranslations("profile");
  const [state, action, pending] = useActionState(completeProfileAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-1.5">
        <Label htmlFor="w-name">{tp("name")}</Label>
        <Input id="w-name" name="name" required maxLength={120} autoComplete="name" autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="w-preferred">{tp("preferred_name")}</Label>
        <Input id="w-preferred" name="preferredName" maxLength={60} autoComplete="nickname" />
        <p className="text-xs text-muted-foreground">{tp("preferred_name_hint")}</p>
      </div>
      {state && !state.ok && (
        <Alert variant="destructive">
          <AlertDescription>{tp(`errors.${state.error}`)}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={pending}>{t("submit")}</Button>
    </form>
  );
}
