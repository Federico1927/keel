import { NextResponse, type NextRequest } from "next/server";
import { applyUnsubscribe } from "@/server/actions/unsubscribe";

/** RFC 8058 one-click unsubscribe (`List-Unsubscribe-Post`): mail clients POST to the URL in the header. */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const ok = await applyUnsubscribe(token);
  return new NextResponse(null, { status: ok ? 200 : 400 });
}
