import { apiEndpoint } from "@hullwise/config";

/** Base URL of the public REST API v1 (#81): `API_URL/v1` in production, `APP_URL/api/v1` locally. */
export function apiBaseUrl(): string {
  return apiEndpoint("/v1");
}
