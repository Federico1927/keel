/**
 * Graph API responses for the levels below the campaign (issue #40), shaped like recorded Marketing
 * API v21.0 answers with identifiers and copy anonymised. Asset breakdowns only return rows for
 * dynamic-creative ads [to verify against a live account].
 */
export const adSetsPage = { data: [{ id: "120210000000101", name: "Prospecting – broad 25-45", status: "ACTIVE", effective_status: "ACTIVE", campaign_id: "120210000000001", optimization_goal: "OFFSITE_CONVERSIONS", daily_budget: "3000" }, { id: "120210000000102", name: "Retargeting 30d", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", campaign_id: "120210000000001", optimization_goal: "OFFSITE_CONVERSIONS" }], paging: { cursors: { before: "a", after: "b" } } };

export const adsPage = {
  data: [
    { id: "120210000001001", name: "VIDEO | UGC unboxing | Price", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "120210000000101", campaign_id: "120210000000001", creative: { id: "9001", title: "Natural linen shirt", body: "Breathable natural linen, free returns.", object_type: "VIDEO", thumbnail_url: "https://cdn.example/thumb1.jpg", url_tags: "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}", link_url: "https://shop.example/products/linen-shirt" } },
    { id: "120210000001002", name: "Dynamic creative – linen", status: "PAUSED", effective_status: "PAUSED", adset_id: "120210000000101", campaign_id: "120210000000001", creative: { id: "9002", object_type: "SHARE", url_tags: "utm_source=facebook", asset_feed_spec: { bodies: [{ text: "Linen that breathes" }, { text: "Made in Portugal" }], titles: [{ text: "Natural linen" }], link_urls: [{ website_url: "https://shop.example/collections/linen" }] } } },
  ],
  paging: { cursors: { after: "end" } },
};

export const adInsights = { data: [{ ad_id: "120210000001001", adset_id: "120210000000101", campaign_id: "120210000000001", spend: "21.40", impressions: "5400", clicks: "120", reach: "3100", actions: [{ action_type: "video_view", value: "1500" }, { action_type: "omni_purchase", value: "3" }], action_values: [{ action_type: "omni_purchase", value: "189.00" }], video_p100_watched_actions: [{ action_type: "video_view", value: "220" }], date_start: "2026-09-28", date_stop: "2026-09-28" }], paging: { cursors: { after: "x" } } };

export const adSetInsights = { data: [{ adset_id: "120210000000101", campaign_id: "120210000000001", spend: "30.10", impressions: "7600", clicks: "160", reach: "4000", actions: [{ action_type: "omni_purchase", value: "4" }], action_values: [{ action_type: "omni_purchase", value: "240.00" }], date_start: "2026-09-28", date_stop: "2026-09-28" }] };

export const bodyAssetInsights = { data: [{ ad_id: "120210000001002", adset_id: "120210000000101", campaign_id: "120210000000001", body_asset: { text: "Linen that breathes", id: "6001" }, spend: "4.20", impressions: "900", clicks: "30", actions: [{ action_type: "omni_purchase", value: "1" }], action_values: [{ action_type: "omni_purchase", value: "59.00" }], date_start: "2026-09-28", date_stop: "2026-09-28" }, { ad_id: "120210000001002", adset_id: "120210000000101", campaign_id: "120210000000001", body_asset: { text: "Made in Portugal", id: "6002" }, spend: "2.10", impressions: "700", clicks: "9", actions: [], date_start: "2026-09-28", date_stop: "2026-09-28" }] };

export const imageAssetInsights = { data: [{ ad_id: "120210000001002", adset_id: "120210000000101", campaign_id: "120210000000001", image_asset: { hash: "abc123", url: "https://cdn.example/img.jpg", id: "7001" }, spend: "6.30", impressions: "1600", clicks: "39", actions: [], date_start: "2026-09-28", date_stop: "2026-09-28" }] };

export const emptyInsights = { data: [] };
