import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { apiEndpoint, isAdPlatformInPlan } from "@hullwise/config";
import { ADS_UTM_TEMPLATES } from "@hullwise/core";
import { GOOGLE_ADS_API_VERSION, META_REQUIRED_PERMISSIONS, SHOPIFY_SCOPES_BY_MODULE, SHOPIFY_WEBHOOK_TOPICS, TIKTOK_API_VERSION, TIKTOK_SCOPES_BY_MODULE } from "@hullwise/integrations";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";

/** One guide per activation: the platforms (TikTok when the plan includes it), then the external providers and tracking; last, the platform email sender (super-admins only: tenants configure nothing). */
const PROVIDERS = ["shopify", "meta", "google", "tiktok", "anthropic", "tracking", "survey", "email"] as const;
type Provider = (typeof PROVIDERS)[number];
interface Step { title: string; body: string; verify?: boolean }

export default async function IntegrationGuidePage({ params }: { params: Promise<{ tenant: string; provider: string }> }) {
  const { tenant, provider } = await params;
  const ctx = await requirePage(tenant, "integrations");
  if (!PROVIDERS.includes(provider as Provider)) notFound();
  const p = provider as Provider;
  const platformAdmin = ctx.user.isSuperAdmin;
  if (p === "email" && !platformAdmin) notFound();
  const tiktok = isAdPlatformInPlan("tiktok", ctx.tenant.planKey);
  if (p === "tiktok" && !tiktok) notFound();
  const t = await getTranslations("integration_guide");
  const ti = await getTranslations("integrations");
  const steps = t.raw(`${p}.steps`) as Step[];
  const errors = t.raw(`${p}.errors`) as { symptom: string; fix: string }[];
  const base = `/t/${tenant}/integrations`;
  const webhookUrl = apiEndpoint("/webhooks/shopify");
  const emailWebhookUrl = apiEndpoint("/webhooks/email");
  const tiktokCallbackUrl = apiEndpoint("/integrations/tiktok/oauth/callback");
  const fill = (body: string) => body.replace("{webhookUrl}", webhookUrl).replace("{emailWebhookUrl}", emailWebhookUrl).replace("{callbackUrl}", tiktokCallbackUrl).replace("{utmTemplate}", ADS_UTM_TEMPLATES.tiktok).replace("{apiVersion}", p === "tiktok" ? TIKTOK_API_VERSION : GOOGLE_ADS_API_VERSION);
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={base} className="hover:underline">← {ti("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t(`${p}.title`)} description={t(`${p}.intro`)} />
      <div className="mb-4 flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm">
        {PROVIDERS.filter((k) => (k !== "email" || platformAdmin) && (k !== "tiktok" || tiktok)).map((k) => (
          <Link key={k} href={`${base}/guide/${k}`} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", k === p ? "bg-card shadow-sm" : "text-muted-foreground")}>{ti(`providers.${k}`)}</Link>
        ))}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{t("verify_legend")}</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="rounded-lg border bg-card p-4" data-testid="guide-step">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                <h3 className="font-medium">{s.title}</h3>
                {s.verify && <Badge variant="warning">{t("verify_badge")}</Badge>}
              </div>
              <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{fill(s.body)}</p>
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
              {t.has(`${p}.scopes`) && <div className="whitespace-pre-line text-muted-foreground">{t(`${p}.scopes`)}</div>}
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
          <Card>
            <CardHeader><CardTitle className="text-base">{t("errors_title")}</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs">
                {errors.map((e, i) => (
                  <li key={i}><span className="font-medium">{e.symptom}</span><br /><span className="text-muted-foreground">{e.fix}</span></li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
