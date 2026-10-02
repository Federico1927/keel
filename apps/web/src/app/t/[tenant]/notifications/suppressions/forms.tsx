"use client";
import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, Input, Label, Select } from "@keel/ui";
import { NOTIFICATION_TYPES } from "@keel/config";
import { addSuppressionAction, removeSuppressionAction } from "@/server/actions/notifications";

const EMAIL_TYPES = (Object.keys(NOTIFICATION_TYPES) as (keyof typeof NOTIFICATION_TYPES)[]).filter((k) => (NOTIFICATION_TYPES[k].channels as readonly string[]).includes("email"));

export function AddSuppressionForm({ slug }: { slug: string }) {
  const t = useTranslations("notifications");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(addSuppressionAction.bind(null, slug), null);
  return (
    <Card>
      <CardContent className="pt-6">
        <form action={action} className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="sup-email">{t("suppressions.email")}</Label>
            <Input id="sup-email" name="email" type="email" required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-category">{t("suppressions.category")}</Label>
            <Select id="sup-category" name="category" defaultValue="all">
              <option value="all">{t("suppressions.all_categories")}</option>
              {EMAIL_TYPES.map((k) => (
                <option key={k} value={k}>{t(`types.${k}`)}</option>
              ))}
              <option value="supplier_po">{t("suppressions.supplier_po")}</option>
              <option value="return_updates">{t("suppressions.return_updates")}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-note">{t("suppressions.note")}</Label>
            <Input id="sup-note" name="note" maxLength={200} />
          </div>
          <Button type="submit" disabled={pending}>{t("suppressions.add")}</Button>
        </form>
        {state && !state.ok && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function RemoveSuppressionButton({ slug, id, label }: { slug: string; id: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => void (await removeSuppressionAction(slug, id)))}>
      {label}
    </Button>
  );
}
