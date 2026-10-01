"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LifeBuoy } from "lucide-react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@keel/ui";
import { openTicketAction } from "@/server/actions/support";

/** Header entry to the platform owner's support: subject, category, message and one optional attachment. */
export function SupportButton({ slug, categories }: { slug: string; categories: string[] }) {
  const t = useTranslations("support");
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);
  return (
    <>
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => { setRound((r) => r + 1); setOpen(true); }} aria-label={t("button")} data-testid="support-button">
        <LifeBuoy className="h-4 w-4" />
        <span className="hidden md:inline">{t("button")}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("new")}</DialogTitle>
            <DialogDescription>{t("new_description")}</DialogDescription>
          </DialogHeader>
          <SupportForm key={round} slug={slug} categories={categories} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function SupportForm({ slug, categories, onDone }: { slug: string; categories: string[]; onDone: () => void }) {
  const t = useTranslations("support");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(openTicketAction.bind(null, slug), null);
  return (
    <>
          {state?.ok ? (
            <div className="space-y-3">
              <Alert>
                <AlertDescription>{t("sent")}</AlertDescription>
              </Alert>
              <Link href={`/t/${slug}/support/${state.data?.id ?? ""}`} onClick={onDone} className="text-sm underline" data-testid="support-sent-link">
                {t("view")}
              </Link>
            </div>
          ) : (
            <form action={action} className="space-y-3" encType="multipart/form-data">
              <div className="space-y-1">
                <Label htmlFor="support-subject">{t("subject")}</Label>
                <Input id="support-subject" name="subject" required maxLength={160} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="support-category">{t("category")}</Label>
                <Select id="support-category" name="category" defaultValue={categories[0]}>
                  {categories.map((c) => (
                    <option key={c} value={c}>{t(`categories.${c}`)}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="support-body">{t("body")}</Label>
                <Textarea id="support-body" name="body" required rows={5} maxLength={8000} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="support-attachment">{t("attachment")}</Label>
                <Input id="support-attachment" name="attachment" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv" />
                <p className="text-xs text-muted-foreground">{t("attachment_hint")}</p>
              </div>
              {state && !state.ok && (
                <Alert variant="destructive">
                  <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
                </Alert>
              )}
              <div className="flex justify-end">
                <Button type="submit" disabled={pending}>{t("send")}</Button>
              </div>
            </form>
          )}
    </>
  );
}
