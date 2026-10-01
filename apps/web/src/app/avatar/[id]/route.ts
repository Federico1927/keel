import { NextResponse } from "next/server";
import { adminDb, and, eq, inArray, schema } from "@keel/db";
import { getAvatar } from "@keel/services";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** Profile photo: visible to the person, to people sharing a workspace with them, and to super-admins. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getCurrentUser();
  if (!viewer || !/^[0-9a-f-]{36}$/.test(id)) return new NextResponse(null, { status: 404 });
  if (viewer.id !== id && !viewer.isSuperAdmin) {
    const m = schema.tenantMemberships;
    const mine = adminDb().select({ t: m.tenantId }).from(m).where(and(eq(m.userId, viewer.id), eq(m.isActive, true)));
    const [shared] = await adminDb().select({ id: m.id }).from(m).where(and(eq(m.userId, id), inArray(m.tenantId, mine))).limit(1);
    if (!shared) return new NextResponse(null, { status: 404 });
  }
  const avatar = await getAvatar(adminDb(), id);
  if (!avatar) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(avatar.data), { headers: { "content-type": avatar.contentType, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
