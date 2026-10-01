# Control Center (Lorena Milano) — Study: Intelligence, CRM, Platform

Source: `/home/user/lorena-control-center` (read-only). React + TS + Supabase (Postgres, RLS, Edge Functions in Deno, pg_cron). All paths below are relative to that repo root unless absolute.

Scope of this study: INTELLIGENCE (campaigns↔stock, ads daily control, P/L & EBITDA, order economics, marketing attribution, Meta/Google sync), CRM (segments, RFM, WhatsApp campaigns with holdout, templates, contacts), PLATFORM (roles/permissions, impersonation, notifications, announcements, integration health, settings, MCP, AI assistant, mobile).

Legend for classification: **GENERIC** = reusable for any e-commerce; **COD-ONLY** = only meaningful for cash-on-delivery; **CLIENT-SPECIFIC** = Lorena / Italy / shoes / Spoki / Elogy.

---

## A. Feature inventory

| Feature | Where (file paths) | What it does | Classification | Logic worth reusing |
|---|---|---|---|---|
| **Order economics view** (`v_order_economics`) | `supabase/migrations/20260703150048_*.sql` (definition), `20260924130001_claims_and_cogs_complete.sql` (cogs_complete fix) | One row per order: `revenue_gross`, `revenue_net = total/1.22`, `cogs = Σ qty × last_purchase_cost`, `cogs_complete` flag, `shipping_cost` from monthly per-shipment cost setting, `mol = revenue_net − cogs − shipping`. Single source of margin reused by every report. | GENERIC (with hard-coded 22% VAT and Europe/Rome → must parametrise) | "Compute margin once in one view, every report joins it". `cogs_complete` boolean propagated with `bool_and` so UIs can show "⚠ COGS incomplete" instead of silently wrong numbers. Service/ancillary lines excluded from completeness check. |
| **Campaign day performance view** (`v_campaign_day_perf`) | `supabase/migrations/20260706201918_*.sql` | FULL OUTER JOIN of daily ad spend (campaign-level rows only) with attributed orders per (campaign, day). Preserves NULLs with `has_ads` / `has_orders` flags so "no ads data" ≠ "spend 0". | GENERIC | Ledger pattern: one row per (date, campaign), ratios never stored, `data_flag` badge (`no_order_data`, `no_ads_data`, `no_spend`, `no_orders`) computed in RPC. Boundary date `controllo_ads_order_data_since` in `app_settings` marks rows before attribution existed. |
| **Controllo Ads (ads daily ledger)** | `src/pages/IntelligenceControlloAds.tsx`, `src/hooks/useControlloAds.ts`, RPCs `controllo_ads_daily`, `controllo_ads_totals` (`20260706201918_*.sql`) | Paginated, server-sorted ledger with spend, view_content, CPC, orders, revenue, MOL, gross profit, ROAS, CPA, ROI, CR%, AOV, platform revenue. KPI strip with weighted totals. CSV export (paged 1000/page, cap 20k). | GENERIC | Rule "never strings in numeric columns": null + reason badge. Server-side sort whitelist, `total_count` on every row for pagination. |
| **Campagne ↔ Stock** | `src/pages/IntelligenceCampagneStock.tsx`, `src/hooks/useCampaignStockReport.ts`, `src/hooks/useCampagneStockSettings.ts`, RPC `campaign_stock_report` (`20260707110940_*.sql`), `campaign_report_flags` table | One row per campaign active in window: spend, orders, revenue, MOL, profit, ROI/CPA/ROAS/cost-per-view/CPC, traffic light `andamento`, recommended `azione_campagna`, linked primary product stock, `azione_stock` (reorder advice), purchasable/repurchasable toggles, exclude flag. Pause/resume via Meta with confirm dialog. | GENERIC | Full decision table in §C.4. Stock from inventory snapshots of the campaign's **primary** linked product. Half-open window `[today−N, today)`. Settings JSON in `app_settings.campagne_stock_settings_v1` (days, stock_limit, roi_good, roi_medium). |
| **Campaign daily report** | `src/pages/IntelligenceCampagneDaily.tsx`, `src/hooks/useCampaignDailyReport.ts`, view `v_campaign_day_perf` | Day-by-day history per campaign: spend, views, attributed orders, revenue, MOL, ROI; platform tab filter; CSV. | GENERIC | Same view as Controllo Ads: "every aggregate on the same window must match across pages". |
| **Vendite Prodotti (product sales + ad spend + stock)** | `src/pages/IntelligenceProductSales.tsx`, RPC `intelligence_product_sales_v2` (`20260902152058_*.sql`), `pl_orders_in_scope`, `intelligence_product_orders`, `intelligence_product_sales_totals`, `product_margin_settings` | Per product: views, orders, units, revenue (net of order discounts, pro-rata), frozen COGS, estimated cancel/return rates (editable per row), MOL, logistics cost, ad spend (campaign-level rows of linked campaigns), profit, ROI, CPA, ROAS, CPC, `andamento`, stock, open POs, reorder advice, purchasable toggle, supplier inline edit. "Unattributed" synthetic row for orphan spend. Sticky totals row with recomputed ratios. | GENERIC (formulas) / CLIENT-SPECIFIC (defaults 28%/6%, €8.90 shipping, VAT 1.22, ancillary titles) | §C.1 formulas. `pl_orders_in_scope(from,to,order_mode,attribution)` as **single definition of the order perimeter** shared by all RPCs (drill-down lists built from the same function so numbers match by construction). Distinct-order totals via separate RPC to avoid double counting multi-product orders. |
| **P/L (EBITDA cascade)** | `src/pages/IntelligencePL.tsx`, `src/hooks/usePLSummary.ts`, `src/lib/pl/*`, RPC `pl_summary(p_from,p_to,p_grain)`, tables `pl_cost_settings`, `pl_logistics_invoices` | Gross → VAT → Net revenue → "Base P/L (confirmed net)" − COGS = Gross margin − Marketing − Logistics − Fixed = EBITDA. Grain day/week/month/quarter/year, YTD preset, period comparison, charts. Fixed costs prorated daily inside their month; logistics invoices prorated over their period and automatically replace per-shipment estimates for covered days. Marketing split Meta/Google. | GENERIC (structure) / CLIENT-SPECIFIC (tags used to classify, 22%, "Incassati" row) | §C.1. Spend dedup per (campaign, day) = `GREATEST(Σ campaign-level, Σ adset-level)`; ad-level rows excluded. COGS frozen at order time in `order_items.unit_cost` (BEFORE INSERT trigger copies `products.last_purchase_cost`) so history never changes. |
| **Order workflow status for P/L** (`pl_order_workflow_status`) | `.lovable/memory/features/pl-workflow-status.md`, migration `20260902092052_*.sql` and later 7-arg version | Classifies each order: annullato > consegnato > confermato > da_confermare, using cancelled_at/status/financial_status/tags/fulfillment/delivery. Used by P/L, Vendite Prodotti, COD queue, marketing order facts. | CLIENT-SPECIFIC (tag list) — pattern GENERIC | Pattern: **one function = one definition of "which orders count"**, used by every aggregate. In Keel this becomes the canonical state machine + `state_rules`. |
| **Marketing attribution (UTM / click-id)** | `supabase/functions/_shared/orderAttribution.ts`, `shopify-webhook`, `shopify-sync`, `shopify-backfill-attribution`, `order-attribution-refresh`, `google-ads` (`attribute_gclids`), table `order_attribution`, trigger `compute_order_channel` (`20260703135317_*.sql`), `src/lib/orderChannel.ts`, `src/components/marketing/AttributionBackfillPanel.tsx` | Extracts utm_*, fbclid, gclid/gbraid/wbraid, ttclid, msclkid, epik, li_fat_id, internal `lm_pid`/`lm_aid` from `landing_site` → `referring_site` → `note_attributes` (keys normalised). Resolves campaign/ad/product FKs with platform-aware fallbacks. Upsert on `order_id` (UNIQUE). `derived_channel` computed by DB trigger in a 4-level cascade (UTM → click id → referrer host → direct/unknown). Three capture levels (webhook, periodic sync, resumable historical backfill). | GENERIC (`lm_pid`/`lm_aid` names are client-specific; make the internal param names configurable) | §C.5 and §C.6. Channel normalisation of dirty `utm_source` values. Google gclid resolved later via `click_view` (one day per query, ≤90 days back). |
| **Marketing Overview (cross-channel)** | `src/pages/marketing/*Overview*`, RPCs `marketing_orders_by_channel_daily`, `marketing_paid_channel_perf`, `src/components/marketing/OrdersByChannelChart.tsx`, `ChannelBreakdownTable.tsx` | KPI strip (orders, revenue, AOV, ad spend, internal ROAS), orders per channel, top-6 channel trend, revenue+AOV per channel, paid channel table (spend, internal revenue, platform revenue, orders, ROAS, CPA), click→order funnel, breakdown by utm_campaign/source/medium/content/term. | GENERIC | Shows platform-reported revenue next to internal last-click revenue and explains the gap. |
| **Meta Marketing sync** | `supabase/functions/facebook-marketing/index.ts` (2325 lines), `adsSync.ts`, `_shared/metaInsights.ts`, tables `campaigns`, `ad_sets`, `ads`, `ad_creatives`, `audiences`, `marketing_metrics_daily`, `meta_backfill_windows`, RPC `claim_meta_backfill_window` (`20260907080703_*.sql`) | Multi-ad-account discovery (`/me/adaccounts`, whitelist in app_settings), campaign/adset/ad CRUD, pause/resume, insights at campaign/adset/ad level with `time_increment=1`, placeholder campaign creation when insights reference unknown campaigns, light `sync_status` per account, resumable month-window backfill queue, rate-limit retry with exponential backoff, page-size halving on "reduce the amount of data", health ack per account. | GENERIC | §C.7 backfill queue, §C.8 retry. `buildMetricFields()` maps Meta `actions[]`/`action_values[]` to flat columns. Budget values converted cents↔euro at the edge. |
| **Google Ads sync** | `supabase/functions/google-ads/index.ts`, table `google_ads_sync_runs` | GAQL REST sync of campaigns/ad groups/ads/daily metrics into the **same** tables with `platform='google_ads'`; MCC login-customer-id; per-run log row; health ack with API version in `meta`; gclid attribution via `click_view`. Read-only. | GENERIC | Unified ad schema across platforms (`platform` discriminator), status mapping ENABLED/PAUSED/REMOVED → active/paused/archived, run-log table with api_version so 404-on-deprecated-version is visible. |
| **Conversion adjustments (retraction)** | `supabase/functions/marketing-conversion-adjustments`, `.lovable/memory/features/conversion-adjustments.md`, table `marketing_conversion_adjustments` | Sends Purchase value=0 (Meta CAPI, event_id=order_<uuid>) or `ConversionAdjustment RETRACTION` (Google) for cancelled orders. Unique `(order_id, platform)`, retry only failed rows. | GENERIC (nice-to-have, post-MVP) | Idempotent outbox per (order, platform). |
| **Campaign → product link + suggestions** | `campaign_product_links` (with partial unique `is_primary`), RPC `campaign_product_suggestions` (`20260822180759_*.sql`), `auto_link_exact_campaigns`, `set_campaign_primary_product`, view `v_campaigns_unlinked`, `src/components/marketing/CampaignsToLinkPanel.tsx`, `UnlinkedCampaignsAlert.tsx`, `CampaignProductPicker.tsx` | Suggests a product for every unlinked campaign by name matching (exact / prefix / contains / first-token), bulk "link all exact", automatic exact auto-link after each platform sync, banner when active campaigns have no product (explains why product ad-spend is 0). | GENERIC | §C.3 algorithm. Atomic single RPC for "set primary" with role check. |
| **Segment builder** | `src/lib/marketing/segmentRules.ts` (types, zod validation, tree helpers, Italian description), `src/components/marketing/SegmentGroupBuilder.tsx`, `SegmentConditionRow.tsx`, `SegmentExclusionsCard.tsx`, `SegmentPreviewPanel.tsx`, SQL `marketing_segment_field_catalog`, `marketing_segment_condition_sql`, `marketing_segment_group_sql`, `marketing_segment_where_sql`, `marketing_segment_validate`, `marketing_segment_evaluate`, `marketing_segment_preview`, `marketing_segment_options` (`20260917180001_marketing_phase2_segments.sql`, `20260923140001_marketing_segment_groups.sql`), table `marketing_segments` | JSON rules (version 1, nested AND/OR groups, max depth 3, max 30 leaf conditions) compiled server-side to a SQL WHERE over a precomputed customer profile table, with a whitelisted field catalog (field → SQL expr + allowed ops + type). Preview returns matched, eligible, exclusions by reason, cost estimate, expected yield, stable masked sample. Options endpoint supplies dropdown values. | GENERIC (field list is partly shoe-specific) | §C.9 schema + compiler. Same validator client-side (zod) and server-side (plpgsql). Error messages carry tree position ("condizione 2.1"). |
| **Customer marketing profile** | `customer_marketing_profile`, `marketing_order_facts`, `marketing_touches`, `marketing_suppressions`, `marketing_settings`, `marketing_profile_rebuild`, `marketing_order_facts_refresh`, `marketing_refresh_tick`, `marketing_refresh_state` (`20260917140001_marketing_phase1_foundations.sql`) | Denormalised per-customer row keyed by normalised phone (`phone_key`): counts of total/confirmed/cancelled/returned/delivered orders, revenue, AOV, first/last/last-confirmed order, open order, top sizes/colours/categories, all sizes/colours/categories, product_ids, discount codes, risk tier, consent, contact ids/tags. Incrementally rebuilt from a watermark every few minutes. | GENERIC (phone-key identity is COD/WhatsApp-driven; Keel should key on customer_id with email/phone match) | Incremental refresh: facts table keyed by order, profile rebuilt only for touched keys, watermark − 10 min overlap. |
| **RFM** | `src/lib/marketing/rfm.ts`, `src/pages/marketing/*Rfm*`, SQL `marketing_rfm_tier`, `marketing_rfm_refresh`, `marketing_rfm_latest`, table `marketing_rfm_snapshots` (`20260929200001_rfm_guard_redirect.sql`) | 8 named tiers + recency×frequency matrix with "spontaneous 90-day rebuy rate" baseline computed from the state 150 days ago; payback threshold; click a cell → pre-filled segment. Nightly snapshot. | GENERIC (tier names are Italian feminine; thresholds configurable) | §C.10. Baseline trick: measure natural rebuy per cell to decide if a message pays back. |
| **WhatsApp campaign builder (Spoki)** | `supabase/functions/spoki-campaigns`, `spoki-campaign-sender`, `_shared/spokiCampaignSend.ts`, `spokiCampaignDb.ts`, `spokiCampaignTotals.ts`, SQL in `20260921150001_marketing_phase4_campaigns.sql` (+ phases 5–12), `src/lib/marketing/campaignDraft.ts`, `campaignSequence.ts`, `alwaysOn.ts`, `src/pages/marketing/*CampagneSpoki*` | 6-step wizard, status machine draft→pending_approval→approved→scheduled→running→completed (+paused/cancelled), preflight checks, holdout, A/B variants, multi-step sequences, always-on daily enrollment with re-entry days, priority preemption, send window 9–20, throttle/minute, lease-based sender with `FOR UPDATE SKIP LOCKED`, recheck exclusions at send time, auto-pause on error rate, uncertain-state reconciliation, personal discount code pools on Shopify. | CLIENT-SPECIFIC as a whole (Spoki, WhatsApp templates, sizes) — but the **campaign engine** (status machine, materialisation, holdout, claim batch, autopause, results) is GENERIC behind a `MessagingChannel` interface | §C.11 holdout, §C.12 sender pattern, state machine `CAMPAIGN_TRANSITIONS`. |
| **Campaign results / uplift** | SQL `marketing_norm_cdf`, `marketing_two_prop`, `spoki_campaign_compute_results` (`20260922100001_marketing_phase5_results.sql`), per-person block (`20260925090001_results_per_person_holdout_advice.sql`), `spoki_campaigns_recap`, `spoki_campaigns_refresh_all_results` (`20260930120001_results_recap.sql`), `src/lib/marketing/campaignResults.ts`, `campaignsRecap.ts`, `src/components/marketing/CampaignResultsCard.tsx` | Intention-to-treat comparison treated vs holdout at 7/14 days: buyer rate diff, 95% CI, two-sided p-value, incremental buyers/delivered orders/margin, cost per extra buyer, margin − cost, per-person margin with Welch-style CI, verdict (positive/negative/inconclusive/insufficient), alternative attribution via dedicated discount code, "claimed by" comparison with Shopify channel. | GENERIC | §C.11 formulas verbatim. |
| **Holdout size advice** | SQL `marketing_holdout_advice`, `src/lib/marketing/holdoutAdvice.ts`, `src/components/marketing/HoldoutAdvicePanel.tsx` | For 5/10/20/30/40/50 % shows holdout size, statistical power at 7 days, minimum detectable effect per 1000, expected extra buyers, expected net €, forgone net €; recommends lowest pct with power ≥ 0.8. Historical basis from past campaigns with holdout ≥ 500, falling back to default rates. | GENERIC | §C.11 power formula. |
| **Contacts** | `src/pages/Contatti.tsx`, `ContactDetailPage.tsx`, `src/lib/customerOrderHistory.ts`, view `v_contacts_list`, triggers keeping `total_orders`/`total_spent` | Unified customer records synced from Shopify; totals recomputed by trigger on orders (match shopify_customer_id → email → phone, excluding voided/refunded); detail shows order history via multi-field match chain (id, email, normalised phone, name+address) up to 3 hops. | GENERIC | Multi-key customer identity resolution with precedence; list reads from a `security_invoker=false` view to keep trigram indexes usable under RLS (see `.lovable/memory/constraints/rls-search-views.md`). |
| **Roles & permissions** | `roles`, `role_permissions`, `user_roles.role_key` (`20260506150219_*.sql`), functions `user_has_page_access`, `current_user_has_page`, `has_role`, `src/components/RolePermissionsManager.tsx`, `src/components/ProtectedRoute.tsx`, `src/contexts/AuthContext.tsx`, `src/components/AppSidebar.tsx` (pageKey per item) | System roles (non-deletable, key immutable) + custom roles; permission = (role_key, page_key); admin always allowed; sidebar and routes gated by `hasPage(pageKey)`; RLS policies call `current_user_has_page('ordini')`. After permission change users must re-login or "refresh permissions". | GENERIC | §C.13. Page keys list. Fallback route = first allowed page. |
| **Impersonation ("Visualizza come")** | `admin_impersonations` table, `current_effective_role`, `real_role`, `is_real_admin` (`20260708194923_*.sql`), `src/components/ImpersonationMenu.tsx`, `ImpersonationBar.tsx`, `AuthContext.startImpersonation/stopImpersonation` | A real admin writes a row (role_key, expires_at = now()+2h); `has_role` and `current_user_has_page` resolve the **effective** role so RLS follows the impersonated role; red banner; audit rows `impersonation_start`/`impersonation_stop`; never grants extra rights; edge functions check the real role. | GENERIC (role impersonation). Keel also needs **tenant** impersonation by super-admin: same pattern with `(admin_user_id, tenant_id, role, expires_at)`. | §C.13. |
| **Notifications** | tables `notifications`, `notification_preferences`, `src/components/NotificationBell.tsx`, `NotificationPreferences.tsx`, `src/pages/Notifiche.tsx`, SQL `spoki_notify_admins` (anti-spam), edge `integration-health-check.notifyAdmins` | Per-user rows with type/title/body/severity/is_read/link_to/metadata; preferences per (user, type, channel); admin broadcast helper with anti-spam window; realtime bell. | GENERIC | §C.15 types; anti-spam "skip if same type within N minutes"; dedupe by `metadata.source`. |
| **Announcements (release notes)** | tables `release_items`, `announcements`, `announcement_reads`; `src/components/announcements/AnnouncementGate.tsx`, `AnnouncementsAdmin.tsx`; `docs/team/22-annunci.md` | Dev registers release items; admin drafts announcement grouped by category, publishes; every user sees unseen published announcements once (DB-tracked), realtime via `postgres_changes`; reset views. | GENERIC | In-app "what's new" with per-user read tracking in DB (not localStorage). |
| **Integration health** | table `integration_health`, RPC `upsert_integration_health` (`20260709121345_*.sql`, `20260907080703_*.sql`), edge `integration-health-check/index.ts`, cron every 10 min, Settings → Integrazioni tab, dashboard widget | Each sync acks `(source, success, last_metric_date, rows_written, error, freshness_minutes)`. Check cron: Meta per account → auto-resync if stale; Shopify/Elogy/Spoki probed from source tables; escalation notification after ≥2 consecutive failures, max 1 per 6 h per source. States ok / stale / idle / error / degraded. | GENERIC | §C.14 state machine and thresholds. |
| **Settings** | `app_settings (key text, value text)`, `marketing_settings (key, value jsonb, description)`, `src/pages/Impostazioni.tsx`, `product_margin_settings` | Key/value settings with RLS (read all authenticated, write admin); JSON blobs for grouped settings; descriptions for marketing settings. | GENERIC (Keel: per-tenant settings table) | Typed accessor `marketing_setting(key)` with COALESCE defaults at every call site. |
| **MCP server for Claude** | `.lovable/mcp/manifest.json`, `src/lib/mcp/index.ts`, `src/lib/mcp/tools/*`, `src/lib/mcp/privacy.ts`, `supabase/functions/mcp/index.ts` (bundled), `docs/team/30-mcp-claude.md` | OAuth (Supabase issuer, audience `authenticated`); every tool creates a Supabase client **as the user** (RLS applies), masks PII (`•••1234`, `m***@domain`), read tools + "prepare only" tools (save segment, draft template, create campaign draft in pending_approval). | GENERIC | §C.16. Tool annotations `readOnlyHint/idempotentHint`. Deep PII masking by key-name regex. |
| **AI assistant (admin chat)** | `supabase/functions/ai-assistant`, `ai_assistant_run_sql`, `ai_assistant_rate_limit_check` (`20260513113259_*.sql`), views `v_ai_*`, `src/components/marketing/ai-assistant/*` | Tool-calling chat (Gemini via gateway) with typed tools + guarded SQL on `v_ai_*` views only (regex whitelist, 8 s timeout, 1000 rows, audit table), 30 msg/h rate limit, inline charts via fenced ```chart blocks, export PDF/XLSX. | GENERIC (provider behind gateway) | Safe-SQL sandbox pattern (§C.17). PII-free views with MD5 hash + masked email domain. |
| **Mobile** | `docs/team/21-uso-da-mobile.md`, `src/index.css`, `src/components/MobileSidebar.tsx`, `MobileBottomNav.tsx`, patched `DialogContent`/`SheetContent` | md breakpoint; dense tables → cards; dialogs `w-[calc(100vw-1rem)] max-h-[90dvh]`; `.table-scroll-x`; safe-area padding; full-width primary buttons. | GENERIC | Patch shadcn primitives once instead of per page. |
| **Date range helper (Rome)** | `src/lib/dateRange.ts`, `src/test/dateRange.test.ts` | Presets computed in the business time zone regardless of device; "last N days" = N full days ending yesterday (Meta convention); custom includes both ends. | GENERIC once tz is a parameter | Replace `ROME_TZ` constant with tenant timezone. |
| **Delivery score / recipient risk / COD queue / operator assignment** | `src/lib/recipientRisk.ts`, `src/lib/codQueue.ts`, `cod-auto-assign-sweep`, `customer_risk_profile`, segment field `risk_tier`, exclusion `risk_blacklisted` | Out of this study's scope but they leak into CRM: segment field `risk_tier`, exclusion `risk_blacklisted`, MCP `get_order` shows COD sub-state. | COD-ONLY | Keep as `addon.cod` contributions to the segment field catalog (addon can register extra fields). |

---

## B. Data model (tables and key columns)

### B.1 Ads & attribution

- **`campaigns`**: `id`, `name`, `platform` (`facebook` \| `google_ads`), `external_id`, `status` (`active`/`paused`/`completed`/`archived`), `ad_account_id`, `ad_account_name`, `objective`, `daily_budget`, `lifetime_budget`, `bid_strategy`, `special_ad_categories`, `buying_type`, `spend_cap`, `bid_cap_amount`, `min_roas`, `start_date`, `end_date`, `budget`, `last_synced_at`, `sync_error`. Platform-specific columns live on the shared table (Keel: keep generic columns + `platform_data jsonb`).
- **`ad_sets`**, **`ads`**, **`ad_creatives`**, **`audiences`**, **`meta_ad_videos`**: Meta hierarchy; `ads.external_id` resolves `utm_content`/`lm_aid`.
- **`marketing_metrics_daily`**: `campaign_id`, `date`, `ad_set_id`, `ad_id`, `breakdown_key` (`''` = total; `video_asset:<id>` rows must not be summed), `breakdown jsonb`, `impressions`, `clicks`, `link_clicks`, `spend`, `conversions`, `purchases`, `add_to_cart`, `initiate_checkout`, `revenue`/`purchase_value`, `reach`, `frequency`, `ctr`, `cpc`, `roas`, `view_content`, `video_3s_views`, `video_thruplays`, `video_p25..p100`, `video_avg_watch_s`. Unique `(campaign_id, date, ad_set_id, ad_id, breakdown_key)` (`MMD_CONFLICT`). Campaign-level rows = `ad_set_id IS NULL AND ad_id IS NULL`.
- **`campaign_product_links`**: `campaign_id`, `product_id`, `is_primary` (partial unique index → at most one primary per campaign), unique `(campaign_id, product_id)`.
- **`campaign_report_flags`**: `campaign_id` PK, `excluded`, `reviewed_at`, `reviewed_by`.
- **`order_attribution`**: `order_id` (UNIQUE), `source` (`utm` \| `click_id` \| `direct`/`organic` \| `webhook` \| `sync` \| `backfill_shopify` \| `google_ads` \| `manual`), `utm_source/medium/campaign/content/term`, `lm_pid`, `lm_aid`, `gclid`, `campaign_id`, `ad_set_id`, `ad_id`, `product_id`, `landing_site`, `referring_site`, `raw jsonb`, `derived_channel` (trigger), `captured_at`.
- **`meta_backfill_windows`**: `ad_account_id`, `month_start`, `month_end`, `level` (`campaign`/`ad`/`video_asset`), `status` (`pending|running|done|error|skipped`), `attempts`, `rows_written`, `started_at`, `completed_at`, `last_error`; unique `(ad_account_id, month_start, level)`.
- **`google_ads_sync_runs`**: `action`, `status` (`running|ok|error`), `api_version`, `customer_ids`, `rows_written`, `message`, `started_at`, `finished_at`.
- **`marketing_conversion_adjustments`**: unique `(order_id, platform)`, `status`.

### B.2 Economics

- **`v_order_economics`** (view): `order_id`, `revenue_gross`, `revenue_net`, `cogs`, `cogs_complete`, `shipping_cost`, `mol`.
- **`pl_cost_settings`**: `category` (`logistics` \| `fixed` \| …), `unit` (`per_shipment` \| `per_month`), `label`, `month`, `estimate_value`, `actual_value`.
- **`pl_logistics_invoices`**: `period_start`, `period_end`, `voice_label`, `amount` (net of VAT) — prorated per day.
- **`order_items.unit_cost`**: frozen COGS at insert.
- **`products`**: `last_purchase_cost`, `is_purchasable`, `is_repurchasable`, `is_ancillary`, `supplier_id`, `launched_at`.
- **`product_margin_settings`**: per-product `cancel_rate`, `return_rate` overrides.
- **`app_settings`** keys used: `vendite_prodotti_stock_threshold`, `vendite_prodotti_roi_ok`, `vendite_prodotti_roi_medio`, `vendite_prodotti_shipping_cost`, `vendite_prodotti_default_cancel_rate`, `vendite_prodotti_default_return_rate`, `campagne_stock_settings_v1` (JSON), `controllo_ads_order_data_since`, `facebook_ad_account_ids_whitelist`, `facebook_sync_cron_secret`, `google_ads_cron_secret`.

### B.3 CRM / campaigns

- **`contacts`**: `shopify_customer_id`, `first_name`, `last_name`, `email`, `phone`, `tags`, `accepts_marketing`, `total_orders`, `total_spent`, `spoki_contact_id`, notes.
- **`marketing_order_facts`** (order_id PK): `phone_key`, `phone_e164`, `order_created_at`, `total`, `financial_status`, `workflow_status`, `is_confirmed`, `is_cancelled`, `is_returned`, `is_delivered`, `is_excluded`, `sizes[]`, `colors[]`, `categories[]`, `product_ids[]`, `discount_codes[]`.
- **`customer_marketing_profile`** (phone_key PK): see §A; plus `sizes_all`, `colors_all`, `categories_all`, `risk_tier`, `wa_receptivity`, `wa_touches_365`, `unresponsive`, `refreshed_at`.
- **`marketing_touches`**: `conversation_id` PK, `phone_key`, `template_name`, `campaign_id`, `status`, `error_code`, `sent_at` (any outbound marketing message = a "touch").
- **`marketing_suppressions`**: `phone_key`, `reason` (enum: `whatsapp_131050`, `spoki_1044`, `unsubscribe_flow`, `spoki_unsubscribed`, `undeliverable_131026`, `manual`, `blacklist`), `source`, `active`, `occurrences`, `first/last_seen_at`, `lifted_at`; unique `(phone_key, reason)`.
- **`marketing_settings`** (key, value jsonb, description): `consent_rule`, `exclude_recent_order_days` (14), `min_days_since_last_marketing` (7), `max_marketing_per_30d` (3), `exclude_open_orders`, `exclude_risk_blacklisted`, `campaign_send_window` ({start, end, tz}), `campaign_autopause_error_rate` (0.15), `campaign_autopause_window_min` (10), `campaign_autopause_min_volume` (20), `campaign_results_windows` ([7,14]), `campaign_results_tracking_days` (21), `campaign_measurement_protect_days` (14), `claim_window_hours` (72), `default_holdout_pct`, `internal_test_phones`, `campaign_credit_reserve_eur`.
- **`marketing_segments`**: `name`, `description`, `rules jsonb`, `is_preset`, `preset_key`, `created_by`, `created_via` (`ui|mcp|system`), `last_preview jsonb`, `last_preview_at`, `archived_at`.
- **`marketing_benchmarks`**: `key`, `kind` (`campaign|segment`), `buyer_rate`, `revenue_per_recipient`, `window_days`, `is_estimate`, `method`.
- **`spoki_campaigns`**: `name`, `status`, `segment_id`, `audience_type` (`segment|internal_test`), `holdout_pct` numeric(5,2) CHECK 0–50, `throttle_per_minute`, `send_window jsonb`, `scheduled_at`, `started_at`, `completed_at`, `paused_at`, `paused_reason`, `approved_by`, `priority`, `always_on`, `reentry_days`, `last_enrolled_at`, `discount_code`, `totals jsonb`, `sender_worker`, `sender_lease_until`, `sender_heartbeat_at`, `created_via`.
- **`spoki_campaign_variants`**: `campaign_id`, `variant_label` (A/B/T38…/ALTRO), `weight`, `template_uuid`, `variables_mapping jsonb`, `send_time`, `step_order`.
- **`spoki_campaign_recipients`**: `campaign_id`, `step_order`, `enrollment_id`, `contact_id`, `phone`, `phone_key`, `variant_label`, `status` (`pending|sending|unknown|sent|delivered|read|failed|skipped|holdout|cancelled`), `skip_reason`, `error_code`, `claimed_at`, `sent_at`, `attempts`, `spoki_message_id`; unique `(campaign_id, step_order, phone, enrollment_id)`.
- **`spoki_campaign_enrollments`** (always-on): `campaign_id`, `phone_key`, `entered_at`, `grp`, `variant_label`.
- **`spoki_campaign_results`**: `campaign_id` PK, `data jsonb` (delivery, errors_by_code, lift{7,14}, per_person, discount_code), `computed_at`, `compute_ms`, `requested_at`, `error`.
- **`marketing_rfm_snapshots`**: `computed_at`, `data jsonb` (cells, tiers, baseline, message_cost_eur).
- **`marketing_audit_log`**: `entity`, `entity_id`, `action`, `actor_id`, `source` (`ui|system|mcp`), `payload`.

### B.4 Platform

- **`roles`** (key PK, label, description, is_system), **`role_permissions`** (role_key, page_key, UNIQUE), **`user_roles`** (user_id, role enum legacy, role_key).
- **`admin_impersonations`** (user_id PK, role_key, started_at, expires_at default +2h).
- **`audit_logs`** (user_id, action, table_name, record_id, old_data, new_data). Note: client inserts directly with a permissive `WITH CHECK (true)` policy — Keel should write audit only server-side.
- **`notifications`** (user_id, type, title, body, severity `info|warning|critical|success`, is_read, link_to, metadata jsonb). **`notification_preferences`** (user_id, notification_type, channel default `in_app`, is_enabled; UNIQUE triple).
- **`integration_health`** (source UNIQUE, category, label, status, last_success_at, last_attempt_at, last_metric_date, last_error, consecutive_failures, rows_written_last, freshness_threshold_minutes default 60, meta jsonb).
- **`announcements`** (title, body_md, image_url, cta_label, cta_link, status `draft|published`, published_at), **`release_items`** (title, description_md, category `feature|improvement|fix`, status `pending|proposed|published|discarded`, announcement_id), **`announcement_reads`** (user_id, announcement_id).
- **`app_settings`** (key PK, value text). **`ai_assistant_threads`**, **`ai_assistant_messages`**, **`ai_assistant_sql_audit`**.

### B.5 Client-specific assumptions baked into the data model (do not copy)

- **VAT 22%** as literal `1.22` in `v_order_economics`, `intelligence_product_sales_v2` (`v_vat := 1.22`), P/L rows "IVA (22%)". Keel: tax rate per tenant country, stored per order line when available.
- **Europe/Rome** everywhere (`timezone('Europe/Rome', …)` in views/RPCs; `romeDay()` in edge functions; `ROME_TZ` in `src/lib/dateRange.ts`; send window tz default). Keel: tenant timezone.
- **"Confermato" counts as sale**: `pl_order_workflow_status` (tags `Confermato`, `Momoka confermato`, `Conferma whatsapp`, `Già pagato`, `Variazione`, `ElogyV2`, `Vendita*`, `PAGATO*`, `consegnato`) plus `fulfillment_status='fulfilled'`; `marketing_order_facts.is_confirmed = workflow_status IN ('confermato','consegnato') AND total > 0 AND NOT excluded`. Keel: canonical state `confirmed|fulfilling|shipped|delivered` computed by `state_rules`.
- **"Annullato per variazione"** tag → `is_excluded_from_counts` (orders replaced by a new order). Keel: `cancelled` with `cancel_reason='replaced'` and an `replaced_by_order_id`.
- **Orders with total = 0** excluded from all aggregates.
- **Phone-keyed customer identity** (`norm_phone_key` strips Italian `39`/`0039` prefix) — driven by WhatsApp/COD; Keel: customer_id + email + E.164 phone.
- **Sizes** (`top_sizes`, `sizes_all`, carousel per size `_T38`, `campaign_carousel_sizes`, `marketing_size_coverage`, `/p/:token` personal page by size) — shoes only. Keel: generic variant options.
- **LM-WA** discount pool title prefix, `LM-XXXXXX` order numbers (`parseOrderNumber` strips `LM-`), `lm_pid`/`lm_aid` URL params, `lorenamilano.com/products/<slug>` regex in `spoki_template_product_ids`.
- Ancillary products by **title** ("Commissione pagamento alla consegna", "Assicurazione pacco") in `cogs_complete`; COD fee line as revenue row.
- Spoki/Meta WhatsApp **tariffs** (`meta_message_tariffs`, `meta_tariff('marketing', date, 'IT')`), credit reserve €100, Spoki error codes (`spoki::1029`, `131050`, `1044`).

---

## C. Patterns in detail (formulas / pseudo-code)

### C.1 Order economics, P/L, product P/L

**Per order (`v_order_economics`)**
```
revenue_gross = orders.total                      -- VAT included, after discounts
revenue_net   = revenue_gross / (1 + vat_rate)    -- CC: /1.22
cogs          = Σ_lines qty × COALESCE(products.last_purchase_cost, 0)
                -- variant resolved by order_items.variant_id, fallback shopify_variant_id
cogs_complete = bool_and(line is ancillary OR cost IS NOT NULL AND cost > 0)
shipping_cost = Σ pl_cost_settings(category='logistics', unit='per_shipment', month = order month)
                  COALESCE(actual_value, estimate_value)
mol           = revenue_net − cogs − shipping_cost
```
Note the P/L proper freezes COGS at order insert (`order_items.unit_cost`), while the view still reads `products.last_purchase_cost` (documented inconsistency). Keel: always use the frozen line cost.

**Per campaign (campaign_stock_report, v_campaign_day_perf)**
```
spend     = Σ marketing_metrics_daily.spend WHERE ad_set_id IS NULL AND ad_id IS NULL  (campaign-level rows only)
orders    = COUNT attributed orders with total > 0 (filters below)
revenue   = Σ orders.total (gross)
mol       = Σ v_order_economics.mol
profit    = mol − spend
roi       = spend > 0 ? (mol − spend) / spend : NULL
roas      = spend > 0 ? revenue / spend : NULL          -- gross revenue in campaign report
cpa       = orders > 0 ? spend / orders : NULL
cpc       = clicks > 0 ? spend / clicks : NULL
cost_per_view = views > 0 ? spend / views : NULL
cr_pct    = clicks > 0 ? orders / clicks : NULL
aov       = orders > 0 ? revenue / orders : NULL
```

**Which orders count for campaign profit** (`campaign_stock_report.order_metrics`):
```
oa.campaign_id IS NOT NULL
AND o.status NOT IN ('annullato','sostituito')
AND lower(o.financial_status) NOT IN ('voided','refunded','partially_refunded')   (NULL allowed)
AND NOT 'Annullato per variazione' = ANY(o.tags)
AND rome_date(o.shopify_created_at) ∈ [today−N, today)
```
Docs for Campagne↔Stock state "only `confermato`"; the SQL actually counts all non-cancelled/non-refunded. Keel rule (CLAUDE.md): **profit counts only orders not cancelled and not returned**; implement as `canonical_status NOT IN ('cancelled','returned','refunded')` and optionally exclude `pending_review`.

**Per product (`intelligence_product_sales_v2`)**, estimated-mode:
```
q          = 1 − cancel_rate − return_rate              -- per product override, else global defaults
revenue_eff= revenue_gross_products × q                 -- revenue of product lines, order discount pro-rata
cogs_eff   = cogs × q
ship_alloc = shipping_cost_per_order / #distinct real products in the order   (ancillary rows get 0)
mol/order  = q × (price_gross/1.22 − cogs_unit − ship_alloc)
mol        = mol/order × orders
logistics  = orders × q × ship_alloc                    -- informational, already inside mol
profit     = mol − ad_spent
roi        = profit / ad_spent ; roas = revenue_eff_net / ad_spent ; cpa = ad_spent/orders ; cpc = ad_spent/clicks
andamento  = roi ≥ roi_ok → va_bene ; roi ≥ roi_medio → va_medio ; else va_male ; no spend → nessuna
azione_stock = stock > threshold → ok ;
               roi ≥ roi_medio AND is_purchasable AND no open PO → riacquista ; else ok
```
Totals row: sums for additive columns; recomputed ratios; distinct orders via `intelligence_product_sales_totals`; weighted COGS unit = Σ(cogs_unit × units)/Σ units.

**P/L cascade (`pl_summary`)**
```
Gross revenue (all non-cancelled, total>0, not excluded)
− VAT                                   = Net revenue
− "of which pending" (net)              = Base P/L (confirmed+delivered, net)
− COGS (Σ qty × unit_cost on confirmed/delivered NOT returned)   = Gross margin
− Marketing (Σ per (campaign,day) GREATEST(campaign-level, Σ adset-level); split by campaigns.platform)
− Logistics (invoices prorated per day; per-shipment estimate × confirmed orders/day for uninvoiced days)
− Fixed costs (per-month voices prorated per day within their month)
= EBITDA
```
Derived KPIs: `% confirmed effective = confirmed / (total − pending)`; `% confirmed incl. returned = (confirmed + cancelled_returned)/(total − pending)`; `% not returned on shipped = confirmed / (confirmed + cancelled_returned)`. AOV comparison uses the same base for both periods.

### C.2 Which orders count — classification function

`pl_order_workflow_status(status, tags, cancelled_at, financial_status, fulfillment_status, delivery_status, delivered_at)`:
1. `annullato` if `cancelled_at IS NOT NULL` OR status ∈ (annullato, sostituito) OR financial ∈ (voided, refunded) OR tag matches `annullato%|rientrat%|da annullare`
2. `consegnato` if `delivered_at IS NOT NULL` OR delivery_status = 'consegnato'
3. `confermato` if confirm tag OR fulfillment_status = 'fulfilled'
4. else `da_confermare` (scheduled confirmations stay here)

Plus `is_excluded_from_counts(tags)` = tag `annullato per variazione` (case/trim-insensitive), plus `total = 0` exclusion. Keel equivalent: canonical status + `state_rules`, exclusion flags `is_replacement`, `is_zero_value`.

### C.3 Campaign → product link suggestion (`campaign_product_suggestions`)

```
norm(x)  = regexp_replace(lower(btrim(x)), '[\s ]+', ' ', 'g')
tok(x)   = lower(regexp_replace(first word of btrim(x), '[^a-zA-Z0-9]', '', 'g'))
for each campaign with no link (MATERIALIZED CTE):
  best product = LATERAL over products ORDER BY
     1 exact    : norm(name) = norm(title)
     2 prefix   : len ≥ 6 both AND (norm(name) LIKE norm(title)||'%' OR vice versa)
     3 contains : len(norm(title)) ≥ 4 AND position(norm(title) in norm(name)) > 0
     4 token    : len(tok) ≥ 3 AND tok(name) = tok(title)
     tie-break: longer title first
     LIMIT 1
order: active campaigns first, then name
```
`auto_link_exact_campaigns(platform)` inserts only `exact` matches, `is_primary=false`, `ON CONFLICT DO NOTHING`, called after each Meta/Google sync. Non-exact matches await manual approval in the "Campaigns to link" panel. Ads additionally carry `url_tags` with `lm_pid=<product_id>` so attribution can resolve the product directly (Keel: `kp_pid` or configurable param name). A second source documented but not fully implemented: product URLs inside ad creatives/templates (`spoki_template_product_ids` regex on `/products/<slug>`); reuse that regex idea for "suggest from ad landing URLs".

### C.4 Traffic light and recommended action (`campaign_stock_report`)

Inputs: `p_days` (7), `p_stock_limit` (30), `p_roi_good` (0.80), `p_roi_medium` (0.20); `is_active = lower(campaigns.status)='active'`; `repurchasable = COALESCE(products.is_repurchasable, true)`; `stock = Σ COALESCE(elogy_net_stock, available_quantity)` over variants of the primary linked product.

```
andamento:
  no_spend AND profit > 0           → VA MEDIO
  no_spend                          → VA MALE
  roi ≥ roi_good                    → VA BENE
  roi > roi_medium                  → VA MEDIO
  else                              → VA MALE

azione_campagna (state × andamento × repurchasable):
  NOT repurchasable, NOT active     → OK
  NOT repurchasable, active         → SPEGNI            -- product cannot be restocked
  VA MALE,  active                  → SPEGNI
  VA MALE,  NOT active              → OK
  VA MEDIO, active                  → CONSIDERA SPEGNIMENTO
  VA MEDIO, NOT active              → CONSIDERA ACCENSIONE
  VA BENE,  active                  → OK
  VA BENE,  NOT active              → ACCENDI

azione_stock:
  excluded                          → OK
  no product / stock unknown        → NULL
  stock ≤ stock_limit AND repurchasable
    AND (VA MEDIO OR (VA BENE AND azione_campagna = OK))  → RIACQUISTA PRODOTTO
  else                              → OK
```
Keel should extend `azione_campagna` with the stock dimension required by CLAUDE.md ("spegni: prodotto sotto la soglia di stock"): e.g. `active AND stock ≤ threshold AND NOT repurchasable AND no incoming PO → SPEGNI (stock)`; `active AND stock ≤ threshold AND incoming PO → CONSIDERA (in arrivo)`. Pause execution: edge `facebook-marketing` action `pause|resume` sets `status` PAUSED/ACTIVE on Meta, UI requires AlertDialog confirmation; local status realigns at next sync.

### C.5 Attribution capture (`_shared/orderAttribution.ts`)

```
params = tracked keys from URL(landing_site)   -- utm_* + EXTRA_KEYS
if none: params = tracked keys from URL(referring_site)
merge note_attributes where normalizeKey(name) is tracked  (lower, trim, [\s-]+ → _, strip non [a-z0-9_])
expectedPlatform = utm_source ∈ {fb,facebook,meta,ig,instagram} → facebook
                 | ∈ {google,google_ads,googleads,adwords}       → google_ads
                 | fbclid → facebook | gclid → google_ads
campaign_id : campaigns.external_id = utm_campaign (prefer expectedPlatform)
ad_id       : ads.external_id = utm_content (prefer platform) → also sets ad_set_id, campaign_id
            : else ads.external_id = lm_aid
product_id  : lm_pid numeric → products.shopify_id ; uuid → products.id
fallback 1  : utm_campaign ILIKE name, unique normalised match → campaign_id
fallback 2  : campaign primary link → product_id
fallback 3  : no campaign but platform known: product from line_items → primary campaign of that platform linked to the product
source      = opts.source ?? (utm_source ? 'utm' : params ? 'click_id' : 'direct')
UPSERT order_attribution ON CONFLICT (order_id)
```
Three capture levels: webhook (live), periodic sync (missed webhooks), historical backfill (REST `/orders.json?status=any`, 250/page, chunks of ≤2 pages per invocation, self-restart, state in `app_settings` JSON). Rule: extend only the shared module.

### C.6 Channel derivation (`compute_order_channel`, trigger on `order_attribution`)

Priority cascade:
1. `utm_source` exact short aliases (`f, fa, fb, face…` → facebook_ads; `ig, insta` → instagram; `yt`; `tt`; `wa`; `direct,(direct),none`)
2. `utm_source` substring: facebook/meta (+ medium organic → meta_organic), instagram (+ paid medium → facebook_ads), google/adwords/gads (+ cpc/paid/ads medium → google_ads else google_organic), tiktok, bing/yahoo/duckduckgo → search_other, youtube, email providers (klaviyo, mailchimp, omnisend, shopify_email, sendgrid, newsletter) → email, whatsapp/spoki → whatsapp
3. click id in landing URL: fbclid → facebook_ads; gclid/gbraid/wbraid → google_ads; ttclid → tiktok_ads; msclkid → bing_ads
4. referrer host: facebook/instagram → meta_organic; google → google_organic; tiktok → tiktok_organic; bing/ddg/yahoo → search_other; youtube
5. landing present → direct; else unknown

Labels/colours centralised in `src/lib/orderChannel.ts`. Keel: make this a table-driven rule set per tenant (`channel_rules`) with the same cascade as default seed.

### C.7 Meta insights backfill — resumable window queue

- Seed: `backfill_plan_seed{since, until, ad_account_ids?, level}` → rows (account × calendar month × level) `status=pending`, upsert `ignoreDuplicates` on `(ad_account_id, month_start, level)`. `monthWindows(since, until)` splits the range into month-aligned [s,u] pairs clamped to the range.
- Tick (cron every minute, `backfill_tick{max_windows=8, budget_ms=50000}`):
  ```
  loop while processed < max_windows and elapsed < budget:
     win = rpc claim_meta_backfill_window()      -- SELECT … WHERE status='pending' OR (status='error' AND attempts<3)
                                                  --   ORDER BY month_start, ad_account_id FOR UPDATE SKIP LOCKED LIMIT 1
                                                  --   UPDATE status='running', attempts+1, started_at=now()
     if none: done=true; break
     try: rows = importCampaignWindow(acc, since, until)   -- level=campaign, time_increment=1, limit 500, paginate paging.next
          update win status='done', rows_written, completed_at
     catch: update win status='error', last_error; RETURN immediately (do not burn retries on rate limit)
  ```
- Unknown campaign ids in insights → `ensureCampaignRecord` creates a placeholder (handles duplicate-key race by re-reading).
- Metric rows upserted in batches of 500 on `MMD_CONFLICT`.
- Live sync (`sync`) pulls last 30 days per account in one account-level insights call (`since = romeDay(today−30)`, `until = romeDay(today)`), then acks `integration_health` per account with `rows_written` and `last_metric_date`.

### C.8 Meta rate-limit / error handling

- `isRetryableMetaError(err)`: fb_code ∈ {4, 17, 32, 613, 80000, 80004} OR HTTP 429/5xx OR message matches `/temporarily unavailable|please reduce the amount of data|rate limit|too many calls|timeout|econnreset|network/i`.
- `backoffMs(attempt) = min(30000, 1000 × 2^(attempt−1))`; `metaRetry` up to 5 attempts; `fetchNext` up to 6 attempts and on "reduce the amount of data" halves the `limit` query param (min 5) before retrying.
- Error normalisation to HTTP codes for the UI: missing token 412, invalid/expired token 401, Meta code 100 → 400 with Meta message, permission `#200` → 403.
- Cron bypass auth with `x-cron-secret` header compared to `app_settings.facebook_sync_cron_secret`.
- `sync_status` light action paginates all campaigns and updates only name/status/budget (per account, staggered crons) to keep ACTIVE/PAUSED fresh under CPU limits.

### C.9 Segment rules — JSON schema and SQL compilation

```jsonc
{ "version": 1,
  "match": "all" | "any",
  "conditions": [
     { "field": "orders_confirmed", "op": "gte", "value": 2 },
     { "match": "any", "conditions": [
         { "field": "bought_size", "op": "any", "value": ["38"] },
         { "field": "bought_size", "op": "any", "value": ["39"] } ] },
     { "match": "any", "conditions": [
         { "field": "days_since_last_confirmed_order", "op": "gte", "value": 60 },
         { "field": "aov_confirmed", "op": "gt", "value": 80 } ] }
  ],
  "exclusions": { "suppressions": true, "consent": true, "recent_order": true, "open_order": true,
                  "recent_marketing": true, "marketing_frequency": true, "risk_blacklisted": true,
                  "invalid_phone": true, "unresponsive": true, "in_measurement": true } }
```
Ops: `gte lte gt lt eq between is_null not_null any none all in not_in`. Types: `number days boolean consent text text_array uuid_array enum`. Limits: depth ≤ 3, ≤ 30 leaves, no empty group, array values 1–200, uuid regex for products.

Field catalog (server, `marketing_segment_field_catalog()` returns jsonb `{field: {type, ops, expr, values?}}`), e.g.
```
orders_confirmed → b.orders_confirmed
days_since_last_confirmed_order → extract(epoch from now() − b.last_confirmed_order_at)/86400
accepts_marketing → CASE … 'true'|'false'|'unknown'
bought_size → b.sizes_all (text_array)   bought_product → b.product_ids (uuid_array)
risk_tier → COALESCE(b.risk_tier,'none')  (enum)
rfm_recency → CASE on last_confirmed_order_at (0-90 | 91-180 | 181-365 | 1-2 anni | oltre 2 anni)
rfm_frequency → CASE on orders_confirmed (1 | 2 | 3-4 | 5+)
rfm_tier → marketing_rfm_tier(orders, last)
random_pct → abs(hashtextextended(b.phone_key, 20260927)) % 100     -- stable random sample
wa_receptivity → b.wa_receptivity ; size_has_new_arrivals → (b.sizes_all && na.sizes)
```
Compilation (`marketing_segment_group_sql(node, depth, path)` recursive):
```
for each element i of node.conditions:
   if element has "conditions": '(' || group_sql(element, depth+1, path||i||'.') || ')'
   else '(' || condition_sql(element, path||i) || ')'
join with ' AND ' (match=all) or ' OR ' (match=any); empty → 'true'
condition_sql: look up catalog[field]; check op ∈ ops; build with format('%s %s %L::numeric', expr, operator, value)
   number: >= <= > < = / BETWEEN %L AND %L / IS NULL / IS NOT NULL
   boolean: COALESCE(expr,false) = %L::boolean
   consent: expr = %L   or   expr = ANY(%L::text[])
   text_array/uuid_array: any → COALESCE(expr && arr,false) ; none → NOT (…) ; all → COALESCE(expr @> arr,false)
   enum/text in/not_in: expr = ANY(arr) / NOT (…)
```
Values are always passed through `%L` (quoted literals); field expressions come only from the catalog → no injection. `marketing_segment_evaluate(rules)` runs `EXECUTE format(... WHERE %14$s ...)` over `customer_marketing_profile b` joined with touches/suppressions and returns each row with `excluded_reasons[]` computed from exclusion flags and settings. `marketing_segment_preview` returns counts, `excluded_by_reason`, masked sample (`ORDER BY hashtext(phone_key) LIMIT ≤50` → stable sample), cost estimate (`eligible × delivery_rate(60d) × tariff`), expected yield from benchmarks weighted by share of eligible with ≥1 confirmed order. Preview is stored on the segment (`last_preview`).

Exclusion logic (`marketing_segment_evaluate` / `spoki_recipient_block_reason`, re-checked at send time):
```
suppressions      : active row in marketing_suppressions
consent           : rule exclude_false → accepts_marketing IS FALSE ; exclude_not_true → IS NOT TRUE
recent_order      : last_order_at ≥ now − exclude_recent_order_days (14)   (+ live check on orders in last 2h)
open_order        : open_order_at not null (order < open_order_max_age_days not delivered/cancelled)
recent_marketing  : last touch from another campaign ≥ now − min_days_since_last_marketing (7)
marketing_frequency: touches in 30d ≥ max_marketing_per_30d (3)
risk_blacklisted  : risk_tier = 'blacklisted'           (COD add-on contribution)
invalid_phone     : no E.164 / < 9 digits / channel says invalid
unresponsive      : ≥3 delivered/read marketing messages after last purchase in 180d
in_measurement    : member (treated or holdout) of a started campaign within campaign_measurement_protect_days (14)
```

### C.10 RFM scoring

Recency bands (days since last confirmed order): `0-90`, `91-180`, `181-365`, `1-2 anni` (≤730), `oltre 2 anni`. Frequency bands (confirmed orders): `1`, `2`, `3-4`, `5+`.

Tier (`marketing_rfm_tier(orders, last)`), evaluated top-down:
```
orders < 1 or last null          → NULL
last ≤ now−730d                  → Perse (Lost)
last ≤ now−365d                  → Dormienti (Dormant)
orders ≥ 5 and last > now−180d   → Campionesse (Champions)
orders ≥ 5                       → Fedeli (Loyal)        -- 5+ but 6–12 months
orders ≥ 3 and last > now−180d   → Fedeli
orders ≥ 2 and last ≤ now−180d   → A rischio (At risk)   -- 2–4 orders, 6–12 months
orders ≥ 2                       → Promettenti (Promising)
last > now−90d                   → Nuove (New)
else                             → Un solo ordine (One-time)
```
Matrix cell metrics: customers, contactable (phone present, no suppression, not unsubscribed, not blacklisted), revenue, avg order. **Baseline**: freeze state at `t0 = now − 150d` (orders before t0 → band), then measure share of customers with ≥1 confirmed order in `[t0, t0+90d)` = `rebuy_90d_rate`, and `revenue_per_customer_90d`. Payback threshold `RFM_PAYBACK_THRESHOLD = 0.13` (a plain message pays back where spontaneous 90-day rebuy ≥ 13%, given ~€19 margin/order and message cost). Click → `rulesForCell(recency, frequency)` / `rulesForTier(tier)` produce segment rules. Nightly snapshot in `marketing_rfm_snapshots`, 400-day retention. The AI view `v_ai_customers_rfm` uses a simpler email-keyed RFM with MD5 hash.

### C.11 Holdout assignment and uplift statistics

**Stable bucket** (`marketing_campaign_bucket(campaign_id, phone_key, salt)`):
```
bucket = (('x' || substr(md5(campaign_id || ':' || phone_key || ':' || salt), 1, 8))::bit(32)::bigint % 10000)
grp     = bucket(campaign, key, 'holdout') < holdout_pct × 100  ? 'holdout' : 'send'
variant = has_B AND bucket(campaign, key, 'variant') ≥ weight_A × 100 ? 'B' : 'A'
```
Deterministic per (campaign, customer) → re-materialising the audience never moves a person between groups; different salts decorrelate holdout and variant. Materialisation also marks `excluded` (reasons) and `overlap` (person pending in another live campaign or touched within min_days). `holdout_pct` CHECK 0–50, default 10, forced 0 for internal tests. Keel's `Segment.holdout_percentage` + per-customer assignment should reuse exactly this hash (salt with `campaign_id`, key = customer_id).

**Results (`spoki_campaign_compute_results`)**, intention-to-treat:
```
population = recipients where status ≠ cancelled and skip_reason ≠ overlap_campaign
grp = status='holdout' ? holdout : treated          (skipped/failed remain treated)
t0  = campaign.started_at (fallback min(sent_at))
for w in windows [7,14]:
   per person: buyer = ≥1 confirmed order with created ∈ [t0, t0+w); orders, delivered_orders, revenue, revenue_delivered, margin(Σ mol)
   tr = aggregates treated ; ho = aggregates holdout
   lift = two_prop(tr.buyers, tr.n, ho.buyers, ho.n)
   incremental_buyers           = (tr.buyers/tr.n − ho.buyers/ho.n) × tr.n
   incremental_delivered_orders = (tr.deliv/tr.n − ho.deliv/ho.n) × tr.n
   incremental_margin           = (tr.margin/tr.n − ho.margin/ho.n) × tr.n
   cost_eur                     = delivered × tariff(t0)
   cost_per_extra_buyer         = cost / incremental_buyers  (if > 0)
   incremental_margin_minus_cost= incremental_margin − cost
   complete                     = now() ≥ t0 + w
   by_variant: same per variant with vs_holdout = two_prop(variant buyers, variant n, ho.buyers, ho.n)
   per_person (added later):
      mt, vt = avg/var_samp margin treated ; mh, vh = avg/var_samp margin holdout
      incremental_margin_per_person = mt − mh ; CI = ± 1.96 × sqrt(vt/tr.n + vh/ho.n)
      cost_per_treated = cost/tr.n ; net_per_person = mt − mh − cost/tr.n (same CI)
      holdout_forgone_net_eur = net_per_person × ho.n
```
Two-proportion test (`marketing_two_prop(x1,n1,x2,n2)`):
```
p1 = x1/n1 ; p2 = x2/n2 ; pp = (x1+x2)/(n1+n2)
se0 = sqrt(pp(1−pp)(1/n1 + 1/n2))         -- pooled, for z
se  = sqrt(p1(1−p1)/n1 + p2(1−p2)/n2)     -- unpooled, for CI
z = (p1−p2)/se0
diff = p1 − p2 ; ci = diff ± 1.96 × se ; p_value = 2 × (1 − Φ(|z|))
Φ via Abramowitz–Stegun 7.1.26 (marketing_norm_cdf)
```
Interpretation (`interpretLift`): p < 0.05 and diff > 0 → "positive significant"; p < 0.05 and diff < 0 → negative; else "not distinguishable from chance"; prefix "Provisional" until window complete. Insufficient control: `holdout buyers < 10 OR holdout people < 1000` → hide incremental margin. Verdicts in recap: positive / negative / inconclusive / insufficient. Recompute: cron every 10 min for `campaign_results_tracking_days` (21) days; "refresh all" over last 45 days.

**Holdout size advice (`marketing_holdout_advice(audience, pcts)`)**:
```
basis: Σ over past campaigns with holdout n ≥ 500 (prefer started ≥ 2 days ago): p0 = hb/hn, p1 = tb/tn,
       net = tm/tn − hm/hn − cost/tn ; default p0=0.001, p1=0.004, net=0 when no history
for h in pcts: n_h = round(audience×h/100), n_t = audience − n_h
   se = sqrt(p1(1−p1)/n_t + p0(1−p0)/n_h)
   power = Φ((p1−p0)/se − 1.96)                          (one-sided at α=0.05 two-sided z)
   min_detectable_per_1000 = (1.96 + 0.8416) × se × 1000
   expected_extra_buyers = (p1−p0) × n_t ; expected_net = net × n_t ; forgone_net = net × n_h
recommendation: lowest h with power ≥ 0.8 ; else "audience too small"
```

### C.12 Campaign sender pattern (generic for any `MessagingChannel`)

- Status machine `CAMPAIGN_TRANSITIONS` (`_shared/spokiCampaignSend.ts`): draft→{pending_approval,cancelled}; pending_approval→{draft,approved,cancelled}; approved→{scheduled,pending_approval,cancelled}; scheduled→{running,paused,cancelled}; running→{paused,completed,cancelled}; paused→{running,completed,cancelled}; completed/cancelled terminal. Enforced by DB trigger `spoki_campaigns_guard` and mirrored client-side (`canDelete`).
- Tick (pg_cron 1 min, `spoki_campaign_tick`): materialise recipients for approved campaigns (→ scheduled), start when `scheduled_at ≤ now` and inside send window (→ running), reconcile `unknown` rows via webhook within 30 min else fail with reason, auto-pause check, totals refresh, completion.
- Claim batch (`spoki_campaign_claim_batch(campaign, worker, limit)`): per-campaign **lease** (`sender_lease_until = now()+2min`, only holder or expired lease may claim); abort if outside send window; budget = `throttle_per_minute − claimed in last minute`, capped at `limit ≤ 100`; `SELECT … WHERE status='pending' ORDER BY created_at, id LIMIT budget×2 FOR UPDATE SKIP LOCKED`; for each row recheck `block_reason` → `skipped` with `skip_reason='at_send:<reason>'` else `sending` + `claimed_at` + attempts+1.
- Auto-pause (`spoki_campaign_autopause_check`): in last `window_min` (10) minutes, if `total ≥ min_volume` (20) and `system_errors/total ≥ error_rate` (0.15) where system errors exclude recipient-level codes → pause, notify admins (anti-spam 30 min), audit. Credit-exhausted error → pause all running campaigns.
- Priority preemption: higher-priority campaign takes a person still pending in another → the other row becomes `skipped (preempted)`.
- Always-on: daily `spoki_campaign_enroll_tick` at configured hour (tenant tz): new segment members not enrolled in last `reentry_days` → enrollment + step-1 recipients; optional daily cap chosen at random; results measured per enrollment cohort.

### C.13 Permissions matrix

Roles (system): `admin`, `operations`, `customer_care`, `marketing` (+ custom). Page keys used by the sidebar/routes: `dashboard, ordini, conferma-cod, resi, sconti, contatti, customer-care, prodotti, inventario, acquisti, intelligence, intelligence-product-sales, intelligence-registro-prodotti, intelligence-variant-mix, intelligence-pl, intelligence-controllo-ads, intelligence-campagne-stock, intelligence-campagne-daily, marketing, logistica, webhook, notifiche, impostazioni, docs`.

Seed (migration 20260506150219):
| page | admin | operations | customer_care | marketing |
|---|---|---|---|---|
| dashboard | ✓ | ✓ | ✓ | ✓ |
| ordini | ✓ | ✓ | ✓ | |
| contatti | ✓ | ✓ | ✓ | |
| conferma-cod | ✓ | ✓ | ✓ | |
| customer-care | ✓ | | ✓ | |
| resi | ✓ | ✓ | ✓ | ✓ |
| prodotti / inventario / riordini | ✓ | ✓ | | |
| intelligence | ✓ | ✓ | | ✓ |
| marketing | ✓ | | | ✓ |
| logistica | ✓ | ✓ | | |
| notifiche | ✓ | ✓ | ✓ | ✓ |
| webhook / impostazioni | ✓ | | | |
| docs | ✓ | ✓ | ✓ | ✓ |

Action-level permissions are not in the matrix; they are hard-coded in RLS/RPCs as role checks (e.g. campaigns write = admin|marketing; `spoki_campaign_is_writer()`; segments insert/update = admin|marketing and not preset; AI assistant = admin). Resolution:
```
current_effective_role() = COALESCE(impersonated role_key if real admin and not expired, real_role(uid))
has_role(uid, r)        = uid = auth.uid() ? current_effective_role() = r : exists user_roles
current_user_has_page(p)= effective role = 'admin' OR exists role_permissions(effective role, p)
```
Client: `AuthContext` loads `admin_impersonations` + `role_permissions` for the effective role → `pages: Set<string>`; `hasPage(p) = role==='admin' || pages.has(p)`; `ProtectedRoute pageKey=…` redirects to the first allowed route in a fixed fallback list. Keel: matrix in `packages/config` with `page × action × role`, server middleware + RLS, plus tenant membership.

### C.14 Integration health states and auto-retry

`upsert_integration_health(source, category, label, success, last_metric_date, rows_written, error, meta, freshness_minutes)`:
```
success → status='ok', last_success_at=now(), consecutive_failures=0, last_error=NULL
failure → consecutive_failures+1 ; status = failures ≥ 3 ? 'degraded' : 'error'
always  → last_attempt_at=now(), last_metric_date=COALESCE(new, old), rows_written_last=COALESCE(new, old), meta = old || new
```
UI-derived states: **ok** (success within `freshness_threshold_minutes` and rows > 0), **idle** (success but 0 rows), **stale** (no success within threshold, no explicit error), **error**, **degraded** (≥2–3 consecutive failures). Thresholds: Meta 60 min (checker uses 45), Shopify 30, Spoki 60, Elogy 240, Google Ads 720.

Checker (cron 10 min): for each Meta account → if no record OR `last_metric_date < today(tz)` OR `last_success_at` older than 45 min → POST `facebook-marketing {action:'sync', ad_account_id}`; if `consecutive_failures ≥ 2` and no notification with `metadata.source` in last 6 h → notify all admins (type `integration_health`, severity warning, link to settings tab). Other sources are probed from their own data tables (`orders.updated_at`, `logistics_events.occurred_at`, `spoki_conversations.created_at`) and acked. Manual "Sync" and "Check now" buttons. Keel: same table per tenant with `source = '<provider>:<account>'`, buttons "Test connection" / "Resync", plus `not_connected|connected|error|syncing` for the connection record itself.

### C.15 Notification types

Found in code: `integration_health` (checker), `spoki_campaign_autopaused`, `spoki_message_sent`, `spoki_template_sent`, `mention` (internal notes @mention), `support_ticket_resolved`, `whatsapp_handoff`, `shopify_publish`, `stock_available` / `stock_disponibile` / `backorder_annullato` (backorder flow), plus docs: `sync_delay`, `reorder_critical`, `ai_rate_limit`, `order_assigned`, `return_submitted`. Preferences UI groups them in 5 categories: `ordini`, `inventario`, `sync`, `ai_studio`, `resi` (type→category mapping is loose). Severity: `info|warning|critical|success`. Broadcast helper: `spoki_notify_admins(type, title, body, severity, link, metadata, antispam_minutes)` skips if a notification of the same type exists within the window; checker dedupes by `metadata.source` per 6 h. Keel: enum of types in `packages/config`, category mapping explicit, per-tenant recipients by role.

### C.16 MCP server

- Manifest: OAuth issuer = Supabase auth, `accepted_audiences: ["authenticated"]`, tools declared with JSON Schema + annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint:false`).
- Every handler: `requireAuth(ctx)` → `supabaseAsUser(ctx)` (anon key + user bearer → RLS enforced; RPCs do their own role checks) → query list views (`v_orders_list`, `v_contacts_list`) → mask (`maskPhone`, `maskEmail`, `maskDeep`) → return `content` text + `structuredContent`.
- Input hardening: `sanitizeSearch` strips `% , ( ) * \`, caps 80 chars; `parseOrderNumber` strips `LM-`/`#`.
- Write tools only create drafts (`created_via='mcp'`) and never send/approve; UI shows "Prepared with Claude" badge. Tool list in §A.
- Keel: same architecture with tenant scoping from the user's membership; connector per tenant.

### C.17 AI assistant safe SQL

`ai_assistant_run_sql(query, limit)`: admin only; strip trailing `;`, reject any `;`, must start with `select|with`, reject DML/DDL keywords, reject `auth.|storage.|vault.|pg_catalog.|information_schema.|user_roles|profiles|customer_email|customer_phone|shipping_address`, must reference at least one `v_ai_*` view; `statement_timeout 8000`; wrap in `SELECT jsonb_agg(t) FROM (<q> LIMIT limit+1) t`, flag `truncated`; audit row with duration/rows/error. Rate limit: count user messages in last hour ≤ 30 → 429 with `reset_at`.

---

## D. Things to explicitly NOT bring into a generic core

1. **Tag-derived order status** (`pl_order_workflow_status`, confirm tags, `Annullato per variazione`, `RIENTRATO`, `PAGATO`, `Già pagato`). Keel derives canonical status from `state_rules`; "which orders count" becomes a pure function over canonical status + payment status.
2. **COD-specific aggregates leaking into analytics/CRM**: `cod_rate`, `cod_pending`, "Conferma COD" page, `is_cod_queue_order`, COD fee revenue rows, `risk_tier`/`risk_blacklisted` segment field and exclusion, delivery score, operator assignment, "Da confermare" as a P/L bucket. All go to `addon.cod` (the add-on may register extra segment fields/exclusions and extra KPIs).
3. **Hard-coded VAT 1.22**, **Europe/Rome**, EUR formatting (`Intl.NumberFormat('it-IT')`), Italian phone normalisation (`norm_phone_key` strips 39), `+39` fallback in test phones.
4. **Shoe/size concepts**: `top_sizes`, `sizes_all`, size carousels (`_T38`, `ALTRO`), size coverage, size collections sync, personal page by size, `campaign_carousel_sizes`, `carton_presets`. Replace with generic variant option values (`option_values_all text[]` keyed by option name).
5. **Spoki/WhatsApp specifics**: template approval states, 24 h free-form window, Spoki error codes, credit snapshots and €100 reserve, `spoki_conversations`, `spoki_contact_state`, Meta message tariffs per country, personal discount pools `LM-WA`, `purge_redeemed` Shopify bulk code deletion. Keep only `MessagingChannel` interface + mock, and the generic campaign engine.
6. **Elogy/Qapla'/GLS** stock and logistics sources (`elogy_net_stock`, `logistics_events`, giacenze), 3PL invoices preset voices.
7. **Phone as customer identity key** for marketing (profile keyed by `phone_key`). Keel keys on `customer_id` with email/phone match tables.
8. **Ancillary products identified by title** ("Commissione pagamento alla consegna", "Assicurazione pacco", mystery boxes) and synthetic UUID rows `…0001/0002`. Keel: `products.is_service` flag + payment fee lines modelled as order-level fees.
9. **Client-side audit insert** (`audit_logs` with `WITH CHECK (true)`), client-side impersonation start via direct table write; **`app_settings.value text`** JSON-in-text blobs; `localStorage`/`sessionStorage` for report controls (fine for UI prefs, not for domain data).
10. **Single-tenant globals**: ad account whitelist in `app_settings`, cron secrets in `app_settings`, `facebook_ad_account_id` default, MCC id in env; Keel stores them per tenant in encrypted integration credentials.
11. **Italian UI strings in code** (every label, enum label, badge text, e.g. `VA BENE`, `SPEGNI`, `Campionesse`) → Keel uses enum codes (`good|medium|bad`, `pause|resume|consider_pause|consider_resume|ok`, `champions|loyal|…`) and i18n files.
12. Hard-coded default estimates (28% cancel, 6% return, €8.90 shipping, 13% payback, €19 margin) — keep as **tenant settings** with neutral defaults.
13. Lovable AI gateway / Gemini coupling in AI assistant; MCP tool descriptions mentioning Lorena; `LM-` order-number parser.
14. Mega-RPCs with 30+ output columns and copy-pasted CTEs (`intelligence_product_sales_v2`, `pl_summary` with `schema_version` history, `DO $$ … replace(pg_get_functiondef…)` migrations that patch functions by string replacement). Keel: calculations in `packages/core` as pure functions; SQL only for set retrieval.

---

## E. Pure utility functions worth reusing verbatim (or near-verbatim)

| Name | Path | What it does |
|---|---|---|
| `extractAttributionParams(payload)` + `isTrackedKey`, `normalizeAttributionKey`, `parseUtmFromUrl` | `supabase/functions/_shared/orderAttribution.ts` | Pull utm_* and click ids from landing/referring URL and note_attributes with key normalisation (relative URLs supported via `https://shop.invalid` base). Rename `lm_pid/lm_aid` to configurable keys. |
| `compute_order_channel(order_attribution)` | `supabase/migrations/20260703135317_*.sql` | Channel cascade (UTM alias table → click id → referrer → direct/unknown). Port to TS in `packages/core` with the alias map as data. |
| `CHANNEL_LABELS`, `channelLabel`, `channelBadgeClass` | `src/lib/orderChannel.ts` | Channel enum, label map (→ i18n keys), badge colour mapping. |
| `buildMetricFields(row)`, `sumActions`, `VIEW_CONTENT_TYPES`, `INSIGHT_METRIC_FIELDS`, `creativeVideoId`, `dynamicVideoCount` | `supabase/functions/_shared/metaInsights.ts` | Map a Meta insights row (`actions[]`, `action_values[]`, video arrays) to flat daily metric columns; vitest-covered. |
| `isRetryableMetaError(err)`, `backoffMs(attempt)` | `supabase/functions/_shared/metaInsights.ts` | Meta retryable error classification (codes 4/17/32/613/80000/80004, 429, 5xx, message regex) + capped exponential backoff. |
| `withRetries(fn, {attempts,label})`, `monthWindows(since, until)` | `supabase/functions/facebook-marketing/index.ts` | Generic retry wrapper; split a date range into month-aligned windows for backfill seeding. |
| `fetchNext` (halve `limit` on "reduce the amount of data") | `supabase/functions/facebook-marketing/adsSync.ts` | Adaptive page-size pagination for Graph API. |
| `claim_meta_backfill_window()` | `supabase/migrations/20260907080703_*.sql` | `FOR UPDATE SKIP LOCKED` claim of the next pending/error(<3 attempts) window; template for any job queue in Postgres (Keel uses pg-boss, but the pattern applies to backfill cursors). |
| `campaign_product_suggestions()` | `supabase/migrations/20260822180759_*.sql` | Name-matching suggestion with 4 match kinds and LATERAL best-match. Port to pure TS `suggestProductForCampaign(name, products)` + tests. |
| `campaign_stock_report` decision CASEs | `supabase/migrations/20260707110940_*.sql` | Traffic light + action + restock rule → `packages/core/campaigns/recommendation.ts`. |
| `marketing_two_prop(x1,n1,x2,n2)`, `marketing_norm_cdf(z)` | `supabase/migrations/20260922100001_marketing_phase5_results.sql` | Two-proportion z-test with 95% CI and p-value; normal CDF (A&S 7.1.26). Port to TS (`twoProportionTest`, `normCdf`). |
| per-person uplift block | `supabase/migrations/20260925090001_*.sql` | Difference of means with Welch CI; net per person; forgone holdout value. |
| `marketing_holdout_advice` core loop | same | Power and MDE for a two-proportion test given audience and holdout %. Port to TS `holdoutAdvice(audience, pcts, basis)`. |
| `powerLabel`, `powerPct`, `recommendedPct`, `adviceText`, `perMille`, `basisNotes` | `src/lib/marketing/holdoutAdvice.ts` | Presentation helpers for the advice table (strings → i18n). |
| `marketing_campaign_bucket(campaign_id, key, salt)` | `supabase/migrations/20260921150001_*.sql` | Stable 0–9999 bucket from md5 → holdout / variant assignment. Port to TS with identical output (test vectors mentioned in `supabase/tests`). |
| `random_pct` expression `abs(hashtextextended(key, seed)) % 100` | `supabase/migrations/20260927110001_*.sql` | Stable random sample field for segments. |
| `segmentRules.ts`: types, `SEGMENT_FIELDS`, `validateSegmentRules`, `countSegmentConditions`, `segmentDepth`, `describeSegmentRules/Sentence`, tree helpers `addConditionAt/addGroupAt/removeAt/updateAt/setMatchAt/moveAt` | `src/lib/marketing/segmentRules.ts` | Complete client-side model of nested AND/OR rules with zod validation and immutable tree editing. Keep structure, move labels to i18n, make field list pluggable (core + add-on fields). |
| `marketing_segment_group_sql` / `marketing_segment_condition_sql` / `marketing_segment_where_sql` | `supabase/migrations/20260923140001_marketing_segment_groups.sql`, `20260917180001_*.sql` | Whitelisted JSON→SQL compiler with `%L` quoting and positional error messages. In Keel port to Drizzle/SQL builder in `packages/core/segments/compile.ts` with the same catalog shape. |
| `marketing_segment_preview` output shape | `20260917180001_*.sql` | `matched / eligible / excluded_by_reason / sample (hash-ordered) / cost / expected / settings / computed_at`. |
| `marketing_rfm_tier(orders, last)`, recency/frequency CASEs, 150-day baseline query | `supabase/migrations/20260929200001_rfm_guard_redirect.sql` | RFM tiering and spontaneous-rebuy baseline. Port to TS `rfmTier(ordersConfirmed, lastOrderAt, now, thresholds)`. |
| `buildRfmMatrix`, `normalizeRate`, `paysBack`, `rulesForCell`, `rulesForTier`, `holdoutTooSmall`, `sortRecency/sortFrequency/sortTiers` | `src/lib/marketing/rfm.ts` | Matrix assembly with row/col totals; payback check; cell → segment rules. |
| `interpretLift`, `netPerPersonTone`, `pickDefaultWindow`, `buildEffectRows`, `pendingOrdersCount`, `rate`, `formatPct/formatPp/formatEur/formatEur3/formatNum` | `src/lib/marketing/campaignResults.ts` | Reading uplift results; formatting (replace it-IT formatting with `Intl` per tenant/user). |
| `verdictLabel`, `toReadCount`, `netTone`, `pctFromFraction`, `refreshToast` | `src/lib/marketing/campaignsRecap.ts` | Campaign recap helpers. |
| `CAMPAIGN_TRANSITIONS`, `canTransition`, `isIsoWithOffset` | `supabase/functions/_shared/spokiCampaignSend.ts` | Campaign status machine shared by server and client. |
| `canDelete`, `startedCount`, `STARTED_KEYS` | `src/lib/marketing/campaignDelete.ts` | Delete rule mirrored from DB guard. |
| `buildCampaignProgressTotals` | `supabase/functions/_shared/spokiCampaignTotals.ts` | Aggregate recipient status counts into progress totals. |
| `addUtm(url, campaign, content, defaults)`, `norm` | `src/lib/marketing/utm.ts` | Add/replace utm_* on a URL preserving other params and fragment (TS replica of SQL `marketing_add_utm`). |
| `claimSentence`, `claimLines`, `claimedBySummary`, `formatHours` | `src/lib/marketing/whatsappClaim.ts` | "Claimed by our campaign within 72 h" vs platform channel comparison (channel-agnostic once labels are i18n). |
| `cleanInternalTestPhones`, `parseInternalTestPhonesSetting` | `src/lib/marketing/internalTestPhones.ts` | Dedupe/clean list settings. |
| `buildSampleRows`, `daysSince`, `formatReceptivity` | `src/lib/marketing/segmentSample.ts` | Sample table rows for segment preview. |
| `nowRome/todayRome/formatRomeDay/toRomeDayString/startOfDayRome/endOfDayRome/romeDayRange/rangeFromPreset/romeDaysAgo/formatRome` | `src/lib/dateRange.ts` (+ tests `src/test/dateRange.test.ts`) | Timezone-safe period presets; parametrise `ROME_TZ` → tenant tz and keep the "N full days ending yesterday" convention and tests. |
| `maskPhone`, `maskEmail`, `maskDeep`, `sanitizeSearch`, `parseOrderNumber` | `src/lib/mcp/privacy.ts` | PII masking and input sanitising for MCP/AI tools (make order-prefix configurable). |
| `buildDraftStateFromMcp`, `buildMcpSaveDraftPayload`, `summarizeCampaignResults` | `src/lib/mcp/campaign-draft-logic.ts` | Pure MCP→draft mapping and Italian summary (i18n). |
| `upsert_integration_health(...)` | `supabase/migrations/20260709121345_*.sql` | Health ack upsert with consecutive-failure escalation; reuse as Drizzle function or SQL. |
| `spoki_notify_admins(type, title, body, severity, link, metadata, antispam_minutes)` | `supabase/migrations/20260917140001_*.sql` | Role broadcast with anti-spam window. |
| `spoki_campaign_claim_batch` (lease + throttle + SKIP LOCKED + recheck) and `spoki_campaign_autopause_check` | `supabase/migrations/20260921150001_*.sql` | Generic rate-limited sender claim and error-rate circuit breaker for any messaging channel. |
| `ai_assistant_run_sql` guard regexes | `supabase/migrations/20260513113259_*.sql` | Read-only SQL sandbox checks. |
| `marketing_refresh_tick` watermark pattern | `supabase/migrations/20260917140001_*.sql` | Incremental profile refresh with 10-minute overlap and keyed rebuild. |

---

### Closing notes for Keel

- Put the **economics** (C.1), **recommendation** (C.4), **attribution parsing + channel cascade** (C.5/C.6), **segment compiler** (C.9), **RFM** (C.10), **holdout + statistics** (C.11) in `packages/core` as pure, tested functions; the SQL in CC is a good spec but tangled with tags, VAT and timezone.
- Keep the **one-perimeter-function** idea (`pl_orders_in_scope`) as a single `ordersInScope(filter)` query builder used by every analytics endpoint and drill-down, so numbers match by construction.
- Keep the **ledger views** (`v_order_economics`, `v_campaign_day_perf`) as tenant-scoped views/materialised tables with `has_ads/has_orders` flags and never store ratios.
- The **campaign engine** (status machine, deterministic holdout, lease-based sender, autopause, ITT results) is channel-agnostic; implement it against `MessagingChannel` with the mock, and keep WhatsApp/Spoki as an ad hoc add-on.
- The COD items in CRM (`risk_tier`, blacklist exclusion) show the add-on needs a hook to **register segment fields/exclusions and KPIs**; design that extension point in the field catalog from day one.
