import { handleApiRequest } from "@hullwise/services";
import { apiDeps } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public REST API v1 (#81), at `apiEndpoint("/v1/...")`: `API_URL/v1/...` in production (the API
 * host maps `/v1/x` to `/api/v1/x`), `APP_URL/api/v1/...` locally. Routing, authentication, limits
 * and errors live in `handleApiRequest` (packages/services/src/api).
 */
async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return handleApiRequest(apiDeps(), req, `/v1/${path.map(encodeURIComponent).join("/")}`);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
export const PUT = handle;
export const OPTIONS = handle;
