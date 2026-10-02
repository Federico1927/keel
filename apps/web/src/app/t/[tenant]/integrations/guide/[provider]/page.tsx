import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME, apiEndpoint, canDo, isAdPlatformInPlan, isPageEnabled } from "@hullwise/config";
import { SPOKI_MODULE } from "@hullwise/addon-spoki";
import { ADS_UTM_TEMPLATES } from "@hullwise/core";
import { GOOGLE_ADDRESS_APIS, GOOGLE_ADS_API_VERSION, LOOP_API_VERSION, META_REQUIRED_PERMISSIONS, RECHARGE_API_VERSION, SUBSCRIPTION_PROVIDERS, SUBSCRIPTION_SCOPES, SUBSCRIPTION_WEBHOOK_TOPICS, SHOPIFY_SCOPES_BY_MODULE, SHOPIFY_WEBHOOK_TOPICS, TIKTOK_API_VERSION, TIKTOK_SCOPES_BY_MODULE } from "@hullwise/integrations";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { spokiWebhookUrl } from "@/server/spoki-webhook";

/** One guide per activation: the platforms (TikTok when the plan includes it), then the external providers and tracking; last, the platform email sender (super-admins only: tenants configure nothing). */
const PROVIDERS = ["shopify", "meta", "google", "tiktok", "anthropic", "address", "subscriptions", "tracking", "survey", "email"] as const;
/** Ad hoc integrations sold per account: an interface and a mock in Hullwise, a live connector built and activated by the Hullwise team (issue #7). */
const AD_HOC = ["payment_guarantee", "return_labels", "audiences", "messaging", "carrier", "warehouse"] as const;
/** Guides of implemented add-ons, shown only to tenants with the add-on (Spoki, issue #9). */
const ADDON_GUIDES = { spoki: SPOKI_MODULE } as const;
type Provider = (typeof PROVIDERS)[number] | (typeof AD_HOC)[number] | keyof typeof ADDON_GUIDES;
const isGuide = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p) || (AD_HOC as readonly string[]).includes(p) || p in ADDON_GUIDES;
interface Step { title: string; body: string; verify?: boolean }

export default async function IntegrationGuidePage({ params }: { params: Promise<{ tenant: string; provider: string }> }) {
  const { tenant, provider } = await params;
  const ctx = await requirePage(tenant, "integrations");
  if (!isGuide(provider)) notFound();
  const p = provider;
  const adHoc = (AD_HOC as readonly string[]).includes(p);
  const platformAdmin = ctx.user.isSuperAdmin;
  if (p === "email" && !platformAdmin) notFound();
  const addonGuides = (Object.keys(ADDON_GUIDES) as (keyof typeof ADDON_GUIDES)[]).filter((k) => ctx.activeAddons.includes(ADDON_GUIDES[k]));
  if (p in ADDON_GUIDES && !addonGuides.includes(p as keyof typeof ADDON_GUIDES)) notFound();
  const tiktok = isAdPlatformInPlan("tiktok", ctx.tenant.planKey);
  if (p === "tiktok" && !tiktok) notFound();
  // the subscription app guide belongs to addon.subscriptions (#67): unreachable without it
  const subscriptions = isPageEnabled("subscriptions", ctx.activeAddons);
  if (p === "subscriptions" && !subscriptions) notFound();
  const t = await getTranslations("integration_guide");
  const ti = await getTranslations("integrations");
  const steps = t.raw(`${p}.steps`) as Step[];
  const errors = t.raw(`${p}.errors`) as { symptom: string; fix: string }[];
  const base = `/t/${tenant}/integrations`;
  // the Spoki URL carries the tenant's secret token: only integration managers see it
  const webhookUrl = p === "spoki" ? (canDo(ctx.role, "manage_integrations") ? spokiWebhookUrl(ctx.tenant.id) : t("spoki.webhook_hidden")) : apiEndpoint("/webhooks/shopify");
  const emailWebhookUrl = apiEndpoint("/webhooks/email");
  const tiktokCallbackUrl = apiEndpoint("/integrations/tiktok/oauth/callback");
  const subscriptionsWebhookUrl = apiEndpoint(`/webhooks/subscriptions/${ctx.tenant.id}`);
  // `{product}` keeps the product name out of the texts (one constant, PRODUCT_NAME)
  const product = { product: PRODUCT_NAME };
  const fill = (body: string) => body.replaceAll("{product}", PRODUCT_NAME).replace("{webhookUrl}", webhookUrl).replace("{emailWebhookUrl}", emailWebhookUrl).replace("{callbackUrl}", tiktokCallbackUrl).replace("{subscriptionsWebhookUrl}", subscriptionsWebhookUrl).replace("{utmTemplate}", ADS_UTM_TEMPLATES.tiktok).replace("{apiVersion}", p === "tiktok" ? TIKTOK_API_VERSION : GOOGLE_ADS_API_VERSION);
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={base} className="hover:underline">← {ti("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t(`${p}.title`, product)} description={t(`${p}.intro`, product)} />
      <nav className="mb-4 space-y-2" aria-label={ti("guides")}>
        <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm">
          {[...PROVIDERS.filter((k) => (k !== "email" || platformAdmin) && (k !== "tiktok" || tiktok) && (k !== "subscriptions" || subscriptions)), ...addonGuides].map((k) => (
            <Link key={k} href={`${base}/guide/${k}`} aria-current={k === p ? "page" : undefined} className={cn("flex-1 whitespace-nowrap rounded-sm px-3 py-1.5 text-center", k === p ? "bg-card shadow-sm" : "text-muted-foreground")}>{ti(`providers.${k}`)}</Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-dashed p-1 text-sm" data-testid="guide-ad-hoc-nav">
          <span className="px-2 text-xs font-medium text-muted-foreground">{t("ad_hoc_title")}</span>
          {AD_HOC.map((k) => (
            <Link key={k} href={`${base}/guide/${k}`} aria-current={k === p ? "page" : undefined} className={cn("whitespace-nowrap rounded-sm px-3 py-1.5 text-center", k === p ? "bg-card shadow-sm" : "text-muted-foreground")}>{ti(`slots.${k}`)}</Link>
          ))}
        </div>
      </nav>
      {adHoc && <p className="mb-4 rounded-md border bg-muted/40 p-3 text-sm" data-testid="ad-hoc-notice">{t("ad_hoc_notice", product)}</p>}
      <p className="mb-4 text-xs text-muted-foreground">{t("verify_legend")}</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="rounded-lg border bg-card p-4" data-testid="guide-step">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                <h3 className="font-medium">{fill(s.title)}</h3>
                {s.verify && <Badge variant="warning">{t("verify_badge")}</Badge>}
              </div>
              <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{fill(s.body)}</p>
            </li>
          ))}
        </ol>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("scopes_title")}</CardTitle>
              <CardDescription>{t("scopes_description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {p === "shopify" && Object.entries(SHOPIFY_SCOPES_BY_MODULE).map(([mod, scopes]) => (
                <div key={mod}><div className="font-medium">{mod}</div><div className="font-mono text-muted-foreground">{scopes.join(", ")}</div></div>
              ))}
              {p === "meta" && <div className="font-mono text-muted-foreground">{META_REQUIRED_PERMISSIONS.join(", ")}</div>}
              {p === "google" && <div className="font-mono text-muted-foreground" data-testid="google-api-version">https://www.googleapis.com/auth/adwords · developer token (Basic access) · OAuth client (Desktop/Web) · refresh token · Google Ads API {GOOGLE_ADS_API_VERSION}</div>}
              {p === "tiktok" && (
                <>
                  {Object.entries(TIKTOK_SCOPES_BY_MODULE).map(([mod, scopes]) => <div key={mod}><div className="font-medium">{t(`tiktok.modules.${mod}`)}</div><div className="font-mono text-muted-foreground">{scopes.join(", ")}</div></div>)}
                  <div className="font-mono text-muted-foreground" data-testid="tiktok-api-version">TikTok API for Business {TIKTOK_API_VERSION} · {tiktokCallbackUrl}</div>
                </>
              )}
              {p === "subscriptions" && SUBSCRIPTION_PROVIDERS.map((sp) => <div key={sp} data-testid={`subscription-scopes-${sp}`}><div className="font-medium">{ti(`providers.${sp}`)}{sp === "recharge" ? ` · API ${RECHARGE_API_VERSION}` : sp === "loop" ? ` · API ${LOOP_API_VERSION}` : ""}</div><div className="font-mono text-muted-foreground">{SUBSCRIPTION_SCOPES[sp].join(", ")}</div></div>)}
              {p === "address" && <div className="font-mono text-muted-foreground" data-testid="address-apis">{GOOGLE_ADDRESS_APIS.join(", ")}</div>}
              {t.has(`${p}.scopes`) && <div className="whitespace-pre-line text-muted-foreground">{t(`${p}.scopes`, product)}</div>}
            </CardContent>
          </Card>
          {p === "shopify" && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("webhooks_title")}</CardTitle></CardHeader>
              <CardContent className="text-xs">
                <p className="mb-1 font-mono break-all">{webhookUrl}</p>
                <p className="font-mono text-muted-foreground">{SHOPIFY_WEBHOOK_TOPICS.join(", ")}</p>
              </CardContent>
            </Card>
          )}
          {p === "subscriptions" && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("webhooks_title")}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-xs">
                <p className="font-mono break-all">{subscriptionsWebhookUrl}</p>
                {SUBSCRIPTION_PROVIDERS.map((sp) => <p key={sp}><span className="font-medium">{ti(`providers.${sp}`)}</span> <span className="font-mono text-muted-foreground">{SUBSCRIPTION_WEBHOOK_TOPICS[sp].join(", ")}</span></p>)}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle className="text-base">{t("errors_title")}</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs">
                {errors.map((e, i) => (
                  <li key={i}><span className="font-medium">{fill(e.symptom)}</span><br /><span className="text-muted-foreground">{fill(e.fix)}</span></li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
