"use client";
import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label } from "@hullwise/ui";
import { removeAddressSuppressionAction, sendTestEmailAction } from "@/server/actions/admin";

export function TestEmailForm({ defaultTo }: { defaultTo: string }) {
  const t = useTranslations("admin.email");
  const [state, action, pending] = useActionState(sendTestEmailAction, null);
  const result = state?.ok && state.data ? (state.data.outcome === "queued" ? t(state.data.mock ? "test_result.queued_mock" : "test_result.queued", { email: state.data.email }) : t(`test_result.${state.data.outcome as "suppressed" | "invalid" | "duplicate"}`)) : null;
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="test-to">{t("test_to")}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="test-to" name="to" type="email" required maxLength={254} defaultValue={defaultTo} />
          <Button type="submit" disabled={pending} data-testid="send-test-email">{t("test_send")}</Button>
        </div>
      </div>
      {result && (
        <Alert variant={state?.ok && state.data?.outcome === "queued" ? "info" : "warning"} data-testid="test-email-result">
          <AlertDescription>{result}</AlertDescription>
        </Alert>
      )}
      {state && !state.ok && (
        <Alert variant="destructive">
          <AlertDescription>{t("test_result.invalid")}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

export function RemoveSuppressionButton({ id }: { id: string }) {
  const t = useTranslations("admin.email");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await removeAddressSuppressionAction(id); router.refresh(); })}>
      {t("remove")}
    </Button>
  );
}
