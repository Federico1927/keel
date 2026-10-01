import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { META_REQUIRED_PERMISSIONS, SHOPIFY_SCOPES_BY_MODULE, SHOPIFY_WEBHOOK_TOPICS } from "@keel/integrations";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";

/** One guide per activation: the three platforms, then the external providers and tracking. */
const PROVIDERS = ["shopify", "meta", "google", "tracking", "survey"] as const;
type Provider = (typeof PROVIDERS)[number];
interface Step { title: string; body: string; verify?: boolean }

export default async function IntegrationGuidePage({ params }: { params: Promise<{ tenant: string; provider: string }> }) {
  const { tenant, provider } = await params;
  const ctx = await requirePage(tenant, "integrations");
  if (!PROVIDERS.includes(provider as Provider)) notFound();
  const p = provider as Provider;
  const t = await getTranslations("integration_guide");
  const ti = await getTranslations("integrations");
  const steps = t.raw(`${p}.steps`) as Step[];
  const errors = t.raw(`${p}.errors`) as { symptom: string; fix: string }[];
  const base = `/t/${tenant}/integrations`;
  const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/webhooks/shopify`;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={base} className="hover:underline">← {ti("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t(`${p}.title`)} description={t(`${p}.intro`)} />
      <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
        {PROVIDERS.map((k) => (
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
              <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{s.body.replace("{webhookUrl}", webhookUrl)}</p>
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
              {p === "google" && <div className="font-mono text-muted-foreground">https://www.googleapis.com/auth/adwords · developer token (Basic access) · OAuth client (Desktop/Web) · refresh token</div>}
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
