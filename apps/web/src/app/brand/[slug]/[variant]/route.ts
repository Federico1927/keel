import { NextResponse } from "next/server";
import { adminDb, eq, schema, withTenant } from "@keel/db";
import { getBrandLogo } from "@keel/services";

export const dynamic = "force-dynamic";

/** Tenant logo for light or dark backgrounds. Public: the customer-facing pages show it too. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; variant: string }> }) {
  const { slug, variant } = await params;
  if (variant !== "light" && variant !== "dark") return new NextResponse(null, { status: 404 });
  const [tenant] = await adminDb().select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  if (!tenant) return new NextResponse(null, { status: 404 });
  const logo = await withTenant(tenant.id, (tx) => getBrandLogo({ tenantId: tenant.id, tx, actor: { type: "system", userId: null } }, variant));
  if (!logo) return new NextResponse(null, { status: 404 });
  // the URL carries ?v=<updatedAt>, so a new upload is a new URL
  return new NextResponse(new Uint8Array(logo.data), { headers: { "content-type": logo.contentType, "cache-control": "public, max-age=86400, stale-while-revalidate=604800", "x-content-type-options": "nosniff" } });
}
