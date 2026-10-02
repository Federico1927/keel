"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { AD_PLATFORM_LABELS } from "@hullwise/config";
import { Pause, Play } from "lucide-react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Select } from "@hullwise/ui";
import { linkProduct, setCampaignStatus, unlinkProduct } from "@/server/actions/campaigns";
import type { ActionResult } from "@/server/action-result";

const PLATFORM_LABEL: Readonly<Record<string, string>> = AD_PLATFORM_LABELS;

export function CampaignStatusButton({ slug, campaignId, platform, status, canPause, readOnly, size = "default", className }: { slug: string; campaignId: string; platform: string; status: string; canPause: boolean; readOnly: boolean; size?: "default" | "sm"; className?: string }) {
  const t = useTranslations("campaign_detail");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  if (!canPause || status === "archived") return null;
  const next = status === "active" ? "paused" : "active";
  const label = PLATFORM_LABEL[platform] ?? platform;
  if (readOnly) return <p className="text-sm text-muted-foreground">{t("read_only", { platform: label })}</p>;
  return (
    <>
      {result && !result.ok && (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{tc(`errors.${result.error}`) + (result.fieldErrors?.platform ? ` (${result.fieldErrors.platform})` : "")}</AlertDescription>
        </Alert>
      )}
      <Button variant={next === "paused" ? "destructive" : "default"} size={size} className={className} disabled={pending} onClick={() => setOpen(true)}>
        {next === "paused" ? <Pause /> : <Play />} {next === "paused" ? t("pause") : t("resume")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{next === "paused" ? t("pause_title", { platform: label }) : t("resume_title", { platform: label })}</DialogTitle>
            <DialogDescription>{next === "paused" ? t("pause_description") : t("resume_description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              disabled={pending}
              variant={next === "paused" ? "destructive" : "default"}
              onClick={() =>
                start(async () => {
                  const r = await setCampaignStatus(slug, campaignId, next);
                  setResult(r);
                  if (r.ok) setOpen(false);
                })
              }
            >
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LinkedProductControls({ slug, campaignId, productId, isPrimary }: { slug: string; campaignId: string; productId: string; isPrimary: boolean }) {
  const t = useTranslations("campaign_detail");
  const [pending, start] = useTransition();
  return (
    <span className="flex gap-1">
      {!isPrimary && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await linkProduct(slug, campaignId, productId, true)))}>
          {t("set_primary")}
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await unlinkProduct(slug, campaignId, productId)))}>
        {t("unlink")}
      </Button>
    </span>
  );
}

export function LinkProductForm({ slug, campaignId, products, hasLinks }: { slug: string; campaignId: string; products: { id: string; title: string }[]; hasLinks: boolean }) {
  const t = useTranslations("campaign_detail");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const [productId, setProductId] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!productId) return;
        start(async () => {
          const r = await linkProduct(slug, campaignId, productId, !hasLinks);
          setResult(r);
          if (r.ok) setProductId("");
        });
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor="link-product">{t("link_product")}</Label>
        <Select size="sm" id="link-product" value={productId} onChange={(e) => setProductId(e.target.value)} className="w-full">
          <option value="">{t("search_product")}</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </Select>
      </div>
      <Button type="submit" size="sm" disabled={pending || !productId}>{t("link_product")}</Button>
      {result && !result.ok && <p className="w-full text-sm text-destructive">{tc(`errors.${result.error}`)}</p>}
    </form>
  );
}
