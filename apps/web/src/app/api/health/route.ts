import { NextResponse } from "next/server";
import { adminDb, sql } from "@keel/db";

/** Liveness + database check for hosting platforms. */
export async function GET() {
  try {
    await adminDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
