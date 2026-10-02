/**
 * GA4 Data API v1beta and Admin API v1beta shapes (#86), recorded from the public reference and
 * anonymised: property 312456789, a fashion store, two days of September 2026. Field names and the
 * quota block are [to verify] on each API version change; re-record by calling `runReport` with the
 * body in `trafficRequest` and pasting the answer.
 */

/** The body `fetchDailyTraffic` sends for 2026-09-27 → 2026-09-28, first page. */
export const trafficRequest = {
  dateRanges: [{ startDate: "2026-09-27", endDate: "2026-09-28" }],
  dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }, { name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }, { name: "landingPagePlusQueryString" }],
  metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "addToCarts" }],
  orderBys: [{ dimension: { dimensionName: "date" } }],
  limit: "10000",
  offset: "0",
  keepEmptyRows: false,
  returnPropertyQuota: true,
};

const headers = {
  dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }, { name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }, { name: "landingPagePlusQueryString" }],
  metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "totalUsers", type: "TYPE_INTEGER" }, { name: "engagedSessions", type: "TYPE_INTEGER" }, { name: "addToCarts", type: "TYPE_INTEGER" }],
};
const row = (dims: string[], mets: number[]) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((v) => ({ value: String(v) })) });
const quota = (dayLeft: number, hourLeft: number) => ({ tokensPerDay: { consumed: 25, remaining: dayLeft }, tokensPerHour: { consumed: 25, remaining: hourLeft }, concurrentRequests: { consumed: 0, remaining: 10 }, serverErrorsPerProjectPerHour: { consumed: 0, remaining: 10 }, potentiallyThresholdedRequestsPerHour: { consumed: 0, remaining: 120 }, tokensPerProjectPerHour: { consumed: 25, remaining: 13975 } });

/** First page: three of five rows. Two rows share a path once the query string goes. */
export const trafficPage1 = {
  ...headers,
  rows: [
    row(["20260927", "Paid Social", "facebook", "paid", "120000030199", "/products/quilted-jacket?utm_source=facebook&utm_medium=paid&fbclid=IwAR36"], [412, 377, 251, 38]),
    row(["20260927", "Paid Social", "facebook", "paid", "120000030199", "/products/quilted-jacket?utm_source=facebook&utm_medium=paid&fbclid=IwAR99"], [18, 18, 9, 1]),
    row(["20260927", "Organic Search", "google", "organic", "(organic)", "/"], [230, 201, 150, 12]),
  ],
  rowCount: 5,
  metadata: { currencyCode: "EUR", timeZone: "Europe/Rome" },
  propertyQuota: quota(199_975, 39_975),
  kind: "analyticsData#runReport",
};

/** Second page (offset 3): the rest, with an empty landing page GA4 reports as `(not set)`. */
export const trafficPage2 = {
  ...headers,
  rows: [
    row(["20260928", "Direct", "(direct)", "(none)", "(direct)", "(not set)"], [96, 90, 41, 3]),
    row(["20260928", "Email", "newsletter", "email", "weekly-39", "/collections/sale?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-39"], [75, 70, 55, 9]),
  ],
  rowCount: 5,
  metadata: { currencyCode: "EUR", timeZone: "Europe/Rome" },
  propertyQuota: quota(199_950, 39_950),
  kind: "analyticsData#runReport",
};

/** A first page that leaves the hourly property quota at zero with rows still to read. */
export const trafficPageQuotaExhausted = { ...trafficPage1, propertyQuota: quota(150_000, 0) };

export const tokenResponse = { access_token: "ya29.c.test-token", expires_in: 3599, token_type: "Bearer" };

export const accountSummaries = {
  accountSummaries: [
    { name: "accountSummaries/2001", account: "accounts/2001", displayName: "Northwind Apparel", propertySummaries: [{ property: "properties/312456789", displayName: "Northwind Apparel – GA4", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/2001" }, { property: "properties/312456790", displayName: "Northwind – staging", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/2001" }] },
  ],
  nextPageToken: "page-2",
};
export const accountSummariesPage2 = { accountSummaries: [{ name: "accountSummaries/2002", account: "accounts/2002", displayName: "Agency sandbox", propertySummaries: [{ property: "properties/400000001", displayName: "Sandbox", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/2002" }] }] };

export const property = { name: "properties/312456789", displayName: "Northwind Apparel – GA4", timeZone: "Europe/Rome", currencyCode: "EUR", propertyType: "PROPERTY_TYPE_ORDINARY" };

/** Error bodies as Google returns them. */
export const errors = {
  quotaHour: { error: { code: 429, message: "Exhausted property tokens per hour for a project per property. These quota tokens will return in under an hour.", status: "RESOURCE_EXHAUSTED" } },
  quotaDay: { error: { code: 429, message: "Exhausted property tokens per day. These quota tokens will return tomorrow.", status: "RESOURCE_EXHAUSTED" } },
  permission: { error: { code: 403, message: "User does not have sufficient permissions for this property. To learn more about Property ID, see https://developers.google.com/analytics/devguides/reporting/data/v1/property-id.", status: "PERMISSION_DENIED" } },
  serviceDisabled: { error: { code: 403, message: "Google Analytics Data API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=123456 then retry.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }] } },
  unauthenticated: { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } },
  invalidProperty: { error: { code: 400, message: "Field property has invalid value: Invalid property ID.", status: "INVALID_ARGUMENT" } },
  unavailable: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } },
  invalidGrant: { error: "invalid_grant", error_description: "Invalid JWT Signature." },
};
