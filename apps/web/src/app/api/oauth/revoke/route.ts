import { revokeOAuthToken } from "@keel/services";
import { corsPreflight, mcpDeps, oauthJson, readOAuthBody } from "@/server/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7009: always 200, whether or not the token existed. */
export async function POST(req: Request) {
  const b = await readOAuthBody(req);
  await revokeOAuthToken(mcpDeps(), { token: b.token, clientId: b.client_id });
  return oauthJson({});
}
export function OPTIONS() {
  return corsPreflight();
}
