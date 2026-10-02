/**
 * TikTok Marketing API v1.3 answers, shaped like recorded responses with identifiers, names, copy and
 * URLs anonymised. Business errors come back as HTTP 200 with a non-zero `code` [to verify the codes
 * against the live error table].
 */
const ok = <T>(data: T) => ({ code: 0, message: "OK", request_id: "20261002000000000000000000000000", data });

export const accessToken = ok({ access_token: "act.example-long-lived-token", advertiser_ids: ["7100000000000000001", "7100000000000000002"], scope: [4, 5, 6, 14] });

export const advertiserInfo = ok({ list: [{ advertiser_id: "7100000000000000001", name: "Example Apparel EU", currency: "EUR", status: "STATUS_ENABLE", timezone: "Europe/Rome" }, { advertiser_id: "7100000000000000002", name: "Example Apparel Outlet", currency: "EUR", status: "STATUS_ENABLE", timezone: "Europe/Rome" }] });

export const campaignsAdv1Page1 = ok({
  list: [
    { campaign_id: "1780000000000101", campaign_name: "Linen drop – Spark Ads", advertiser_id: "7100000000000000001", objective_type: "WEB_CONVERSIONS", operation_status: "ENABLE", secondary_status: "CAMPAIGN_STATUS_ENABLE", budget: 80.5, budget_mode: "BUDGET_MODE_DAY", create_time: "2026-06-01 09:30:00" },
    { campaign_id: "1780000000000102", campaign_name: "Retargeting 14d", advertiser_id: "7100000000000000001", objective_type: "WEB_CONVERSIONS", operation_status: "DISABLE", secondary_status: "CAMPAIGN_STATUS_DISABLE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE", create_time: "2026-05-10 12:00:00" },
  ],
  page_info: { page: 1, page_size: 1000, total_number: 3, total_page: 2 },
});
export const campaignsAdv1Page2 = ok({ list: [{ campaign_id: "1780000000000103", campaign_name: "Old test", advertiser_id: "7100000000000000001", objective_type: "TRAFFIC", operation_status: "DISABLE", secondary_status: "CAMPAIGN_STATUS_DELETE", budget: 20, budget_mode: "BUDGET_MODE_DAY", create_time: "2025-11-02 08:00:00" }], page_info: { page: 2, page_size: 1000, total_number: 3, total_page: 2 } });
export const campaignsAdv2 = ok({ list: [{ campaign_id: "1780000000000201", campaign_name: "Outlet – Smart+", advertiser_id: "7100000000000000002", objective_type: "PRODUCT_SALES", operation_status: "ENABLE", secondary_status: "CAMPAIGN_STATUS_ENABLE", budget: 30, budget_mode: "BUDGET_MODE_DAY", create_time: "2026-08-15 10:00:00" }], page_info: { page: 1, page_size: 1000, total_number: 1, total_page: 1 } });

export const adGroups = ok({ list: [{ adgroup_id: "1780000000001101", adgroup_name: "Broad 18-34 IT", campaign_id: "1780000000000101", operation_status: "ENABLE", secondary_status: "ADGROUP_STATUS_DELIVERY_OK", optimization_goal: "CONVERT", budget: 40, budget_mode: "BUDGET_MODE_DAY" }, { adgroup_id: "1780000000001102", adgroup_name: "Interest – fashion", campaign_id: "1780000000000101", operation_status: "DISABLE", secondary_status: "ADGROUP_STATUS_DISABLE", optimization_goal: "CONVERT", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" }], page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 1 } });

export const ads = ok({
  list: [
    { ad_id: "1780000000002101", ad_name: "UGC try-on | hook 1", adgroup_id: "1780000000001101", campaign_id: "1780000000000101", operation_status: "ENABLE", secondary_status: "AD_STATUS_DELIVERY_OK", ad_format: "SINGLE_VIDEO", ad_text: "Linen that breathes all summer. Free returns.", display_name: "Example Apparel", video_id: "v10033g50000example01", image_ids: [], landing_page_url: "https://shop.example/products/linen-shirt?utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__&utm_term=__AID__" },
    { ad_id: "1780000000002102", ad_name: "Carousel – colours", adgroup_id: "1780000000001101", campaign_id: "1780000000000101", operation_status: "DISABLE", secondary_status: "AD_STATUS_DISABLE", ad_format: "CAROUSEL_ADS", ad_text: "Six colours, one fit.", display_name: "Example Apparel", image_ids: ["ad-site-i18n-sg/202610020000example1", "ad-site-i18n-sg/202610020000example2"], landing_page_url: "https://shop.example/collections/linen?utm_source=tiktok" },
  ],
  page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 1 },
});
export const videoInfo = ok({ list: [{ video_id: "v10033g50000example01", video_cover_url: "https://p16-example.tiktokcdn.com/cover01.jpeg", duration: 18.4, width: 720, height: 1280 }] });

const m = (o: Record<string, string>) => ({ spend: "0", impressions: "0", clicks: "0", reach: "0", conversion: "0", complete_payment: "0", total_complete_payment_rate: "0", video_play_actions: "0", video_watched_2s: "0", video_views_p100: "0", average_video_play: "0", ...o });

export const campaignReportDay1 = ok({ list: [{ dimensions: { campaign_id: "1780000000000101", stat_time_day: "2026-09-28 00:00:00" }, metrics: m({ spend: "61.37", impressions: "18450", clicks: "212", reach: "15022", conversion: "9", complete_payment: "7", total_complete_payment_rate: "498.60", video_play_actions: "16100", video_watched_2s: "7400", video_views_p100: "910", average_video_play: "4.21" }) }], page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 2 } });
export const campaignReportDay2 = ok({ list: [{ dimensions: { campaign_id: "1780000000000101", stat_time_day: "2026-09-29 00:00:00" }, metrics: m({ spend: "58.00", impressions: "17020", clicks: "190" }) }], page_info: { page: 2, page_size: 1000, total_number: 2, total_page: 2 } });
export const emptyReport = ok({ list: [], page_info: { page: 1, page_size: 1000, total_number: 0, total_page: 0 } });

export const adGroupReport = ok({ list: [{ dimensions: { adgroup_id: "1780000000001101", stat_time_day: "2026-09-28 00:00:00" }, metrics: m({ campaign_id: "1780000000000101", spend: "40.10", impressions: "12100", clicks: "150", reach: "9900", complete_payment: "5", total_complete_payment_rate: "355.00", video_watched_2s: "5200", video_views_p100: "640" }) }], page_info: { page: 1, page_size: 1000, total_number: 1, total_page: 1 } });
export const adReport = ok({ list: [{ dimensions: { ad_id: "1780000000002101", stat_time_day: "2026-09-28 00:00:00" }, metrics: m({ campaign_id: "1780000000000101", adgroup_id: "1780000000001101", spend: "33.25", impressions: "9800", clicks: "131", reach: "8100", complete_payment: "4", total_complete_payment_rate: "289.00", video_play_actions: "9100", video_watched_2s: "4300", video_views_p100: "520", average_video_play: "5.02" }) }, { dimensions: { ad_id: "1780000000002102", stat_time_day: "2026-09-28 00:00:00" }, metrics: m({ spend: "6.85", impressions: "2300", clicks: "19" }) }], page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 1 } });

export const statusUpdated = ok({ campaign_ids: ["1780000000000101"] });
export const adStatusUpdated = ok({ ad_ids: ["1780000000002101"] });

export const rateLimited = { code: 40100, message: "Requests made too frequently. Please try again later.", request_id: "20261002000000000000000000000001", data: {} };
export const tokenExpired = { code: 40105, message: "The access token is invalid or has been revoked.", request_id: "20261002000000000000000000000002", data: {} };
export const noPermission = { code: 40001, message: "No permission to operate advertiser 7100000000000000001.", request_id: "20261002000000000000000000000003", data: {} };
export const authCodeUsed = { code: 40002, message: "Auth code is expired or has been used.", request_id: "20261002000000000000000000000004", data: {} };
