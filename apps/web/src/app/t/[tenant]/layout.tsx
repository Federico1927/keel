import { AppShell } from "@/components/app-shell/app-shell";
import { getTenantContext } from "@/server/tenant";

export default async function TenantLayout({ children, params }: { children: React.ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await getTenantContext(tenant);
  return <AppShell ctx={ctx}>{children}</AppShell>;
}
