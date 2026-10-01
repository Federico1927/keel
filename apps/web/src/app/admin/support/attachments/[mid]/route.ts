import { NextResponse, type NextRequest } from "next/server";
import { adminSupportAttachment } from "@keel/services";
import { requireSuperAdmin } from "@/server/admin";

/** A tenant's support attachment opened from the console: audited by the service. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ mid: string }> }) {
  const { mid } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(mid)) return new NextResponse("not found", { status: 404 });
  const { user, db } = await requireSuperAdmin();
  const file = await adminSupportAttachment(db, mid, user.id);
  if (!file) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(file.data), { headers: { "content-type": file.type, "content-disposition": `attachment; filename="${encodeURIComponent(file.name)}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
