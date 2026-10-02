"use client";
import { useActionState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { SUPPORTED_LOCALES } from "@hullwise/config";
import { PAYMENT_METHODS, type TenantSettings } from "@hullwise/core";
import type { ActionResult } from "@/server/action-result";
import { deleteTaxRate, updateGeneralSettings, updateOperationalSettings, upsertTaxRate } from "@/server/actions/settings";

function Feedback({ state }: { state: ActionResult | null }) {
  const t = useTranslations("common");
  if (!state) return null;
  if (state.ok) return <Alert variant="info"><AlertDescription>{t("saved")}</AlertDescription></Alert>;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {t(`errors.${state.error}`)}
        {state.fieldErrors && <span className="block text-xs">{Object.entries(state.fieldErrors).map(([k, v]) => `${k}: ${v}`).join(" · ")}</span>}
      </AlertDescription>
    </Alert>
  );
}

export function GeneralSettingsForm({ slug, values }: { slug: string; values: { name: string; country: string; currency: string; timezone: string; defaultLocale: string; orderNumberPrefix: string } }) {
  const t = useTranslations("settings.general");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(updateGeneralSettings.bind(null, slug), null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="name">{t("name")}</Label>
            <Input id="name" name="name" defaultValue={values.name} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">{t("country")}</Label>
            <Input id="country" name="country" defaultValue={values.country} maxLength={2} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="currency">{t("currency")}</Label>
            <Input id="currency" name="currency" defaultValue={values.currency} maxLength={3} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">{t("timezone")}</Label>
            <Input id="timezone" name="timezone" defaultValue={values.timezone} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="defaultLocale">{t("default_locale")}</Label>
            <Select id="defaultLocale" name="defaultLocale" defaultValue={values.defaultLocale}>
              {SUPPORTED_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {tc(`locales.${l}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="orderNumberPrefix">{t("order_prefix")}</Label>
            <Input id="orderNumberPrefix" name="orderNumberPrefix" defaultValue={values.orderNumberPrefix} maxLength={10} />
          </div>
          <div className="sm:col-span-2 flex items-center justify-between gap-4">
            <Feedback state={state} />
            <Button type="submit" disabled={pending}>
              {tc("save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const numericFields: (keyof TenantSettings)[] = [
  "lowStockThreshold",
  "coverageDaysWarning",
  "coverageDaysCritical",
  "salesVelocityLookbackDays",
  "reorderTargetDays",
  "roiGood",
  "roiMedium",
  "campaignStockThreshold",
  "duplicateOrderWindowDays",
  "historyImportMonths",
  "shipmentStuckDays",
  "returnWindowDays",
  "returnShippingFallbackDays",
  "shippingCostMinor",
  "churnLowPct",
  "churnMediumPct",
  "markdownMinMarginBps",
  "adsDailyRetentionDays",
  "adsSearchTermMinImpressions",
  "adsMinSpendMinor",
];

export function OperationalSettingsForm({ slug, settings, currency }: { slug: string; settings: TenantSettings; currency: string }) {
  const t = useTranslations("settings.operational");
  const tc = useTranslations("common");
  const tp = useTranslations("payment_methods");
  const [state, action, pending] = useActionState(updateOperationalSettings.bind(null, slug), null);
  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("thresholds_title")}</CardTitle>
          <CardDescription>{t("thresholds_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {numericFields.map((f) => (
            <div key={f} className="space-y-2">
              <Label htmlFor={f}>{t(`fields.${f}`)}</Label>
              <Input id={f} name={f} type="number" step="any" defaultValue={String(settings[f])} />
            </div>
          ))}
          <div className="space-y-2 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="returnExcludedProductTypes">{t("fields.returnExcludedProductTypes")}</Label>
            <Input id="returnExcludedProductTypes" name="returnExcludedProductTypes" defaultValue={settings.returnExcludedProductTypes.join(", ")} placeholder={t("fields.returnExcludedProductTypes_placeholder")} />
          </div>
        </CardContent>
      </Card>
      <Card data-testid="backorder-settings">
        <CardHeader>
          <CardTitle>{t("backorders_title")}</CardTitle>
          <CardDescription>{t("backorders_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <input type="hidden" name="backorderSettings" value="1" />
          <label className="flex items-start gap-2">
            <input type="checkbox" name="backorderHold" defaultChecked={settings.backorderHold} className="mt-0.5" />
            <span>{t("fields.backorderHold")}</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="backorderPlatformHold" defaultChecked={settings.backorderPlatformHold} className="mt-0.5" />
            <span>{t("fields.backorderPlatformHold")}</span>
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("fees_title")}</CardTitle>
          <CardDescription>{t("fees_description", { currency })}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("fee_method")}</TableHead>
                <TableHead>{t("fee_percent")}</TableHead>
                <TableHead>{t("fee_fixed")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {PAYMENT_METHODS.map((m) => (
                <TableRow key={m}>
                  <TableCell className="font-medium">{tp(m)}</TableCell>
                  <TableCell>
                    <Input name={`fee_bps_${m}`} type="number" step="1" defaultValue={settings.paymentFeeBps[m]} className="max-w-[8rem]" aria-label={`${tp(m)} bps`} />
                  </TableCell>
                  <TableCell>
                    <Input name={`fee_fixed_${m}`} type="number" step="1" defaultValue={settings.paymentFeeFixedMinor[m]} className="max-w-[8rem]" aria-label={`${tp(m)} fixed`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between gap-4">
        <Feedback state={state} />
        <Button type="submit" disabled={pending}>
          {tc("save")}
        </Button>
      </div>
    </form>
  );
}

export function TaxRatesSection({ slug, rates }: { slug: string; rates: { country: string; rateBps: number; pricesIncludeTax: boolean }[] }) {
  const t = useTranslations("settings.taxes");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(upsertTaxRate.bind(null, slug), null);
  const [, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("country")}</TableHead>
              <TableHead>{t("rate")}</TableHead>
              <TableHead>{t("prices_include_tax")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  {tc("empty")}
                </TableCell>
              </TableRow>
            )}
            {rates.map((r) => (
              <TableRow key={r.country}>
                <TableCell className="font-medium">{r.country}</TableCell>
                <TableCell className="tabular">{(r.rateBps / 100).toFixed(2)}%</TableCell>
                <TableCell>{r.pricesIncludeTax ? tc("yes") : tc("no")}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" aria-label={tc("delete")} onClick={() => start(() => void deleteTaxRate(slug, r.country))}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <form action={action} className="grid items-end gap-3 sm:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="tax-country">{t("country")}</Label>
            <Input id="tax-country" name="country" maxLength={2} placeholder="IT" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax-rate">{t("rate")}</Label>
            <Input id="tax-rate" name="ratePercent" type="number" step="0.01" min="0" max="100" placeholder="22" required />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox name="pricesIncludeTax" defaultChecked /> {t("prices_include_tax")}
          </label>
          <Button type="submit" disabled={pending}>
            {t("add")}
          </Button>
          <div className="sm:col-span-4">
            <Feedback state={state} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
