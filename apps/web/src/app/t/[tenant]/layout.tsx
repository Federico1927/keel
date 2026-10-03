import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell/app-shell";
import { getTenantContext } from "@/server/tenant";
import { IntlScope } from "@/i18n/intl-scope";

export default async function TenantLayout({ children, params }: { children: React.ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await getTenantContext(tenant);
  // a person without a name (invited by email, first sign-in) completes the profile first
  if (!ctx.user.name?.trim() && !ctx.impersonation) redirect(`/welcome?next=${encodeURIComponent(`/t/${tenant}`)}`);
  return <IntlScope route="app/t/[tenant]/layout.tsx"><AppShell ctx={ctx}>{children}</AppShell></IntlScope>;
}
