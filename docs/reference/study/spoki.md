# Spoki (WhatsApp) integration in the Control Room — study notes

Read-only study, 2026-10-01, of `lorena-control-center`. No secrets, phone numbers or customer data copied. Purpose: rebuild it as the optional add-on `addon.whatsapp_spoki` in Keel (requested by Federico, overriding CLAUDE.md §12 for this connector).

## Spoki API actually used (base `https://api.spoki.com/api/1`, header `X-Spoki-Api-Key`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/messages/send/` | Every send. Template `{type:"Template", phone:"+E164", template:<int id>, custom_fields:{K:V}}`; text `{type:"Message", content_type:"Text", phone, text}`; media `content_type: Image\|Document\|Video\|Audio`, `media`/`url`, `caption`, `filename`; interactive `content_type:"Interactive"`, `buttons[{button_type:"quick_reply", text≤20, order}]` max 3. A send is OK only if the response carries a message `id`/`uuid`. |
| GET | `/templates/?page_size=100` (follow `next`) | Approved templates (`templatelocalization_set`, `customfield_set`; status 0 draft, 1 pending, 2/4 approved, 3 rejected). |
| GET | `/contacts/?phone=<digits>` then `?phone=+<digits>` | Contact id and `chat_link`. |
| GET | `/contacts/{id}/` | Authoritative `chat_link`. Returns no message history. |
| GET | `/contacts/?page_size=200` | Bulk contact sync: subscribed/unsubscribed, chat uid. |
| POST | `/tickets/` | Optional human handoff `{contact_phone, title, status:"Open", priority:"Medium", description}`. |
| GET | account path (probed) | Optional credit (`current_credit` in thousandths of a euro). |
| POST/PATCH/DELETE | `/templates/…`, `/submit/`, `/revert/`, `/media/` | Optional template authoring. |

Rate limit: 429 → retry 3× with `max(Retry-After, 1.2 s·2^n)`. Error codes seen: `spoki::1029` credit exhausted (pause everything), `whatsapp::131026` undeliverable, `whatsapp::131050` user stopped marketing, `spoki::1044`, `whatsapp::131049`, `whatsapp::131053` media not downloadable, `spoki::3004`.

## Inbound webhook

- Shared secret (no HMAC) accepted in `?secret=`, `x-spoki-secret`, `Authorization`, `x-spoki-signature`; 401 on mismatch. ACK 200 at once, process in background; replay mode runs synchronously.
- Envelope `{event|type, data|message|payload|result}`; `message.inbound` / `message.outbound`. Spoki re-sends the same outbound uuid with updated `send_status` (Sent/Delivered/Read/Error): there are no separate delivered/read events; the first Sent of a template lacks `template`.
- Fields: message id (`id`/`uuid`), direction, phone (many fallbacks: `from_phone`, `to_phone`, `contact.phone`, `wa_id`, `chat_id` split on `@`, vcard `waid=`), status, body/text, `contact.id`, `chat_uuid`, `created_at`, `template`, `error_code`, `replyToMessageUid`, `mediamessage_set`.
- Steps: resolve contact id (via chat uid) → resolve phone (via contact id) else dead-letter → link order (normalised phone key, last 30 days; campaign messages never touch orders) → upsert contact → upsert conversation idempotently on message id (race → update) → update order last status (inbound = replied).
- Errors go to a dead-letter table with retry count; replay function + cron every 5 min (max 5 retries, min age 5 min).
- Status order is forward-only: sent < failed < delivered < read; replied on inbound.

## Data model (generic parts)

- `spoki_conversations(spoki_message_id unique, spoki_contact_id, phone, direction in/out, body, template_name, status, order_id, campaign_id, payload, occurred_at)`; realtime; RLS read for staff, write service only.
- `spoki_template_favorites(user_id, template_id, template_name)`.
- `spoki_webhook_errors(error_message, error_stage, event_type, phone, message id, contact id, order_id, payload, resolved, retry_count, last_retry_at)`.
- `spoki_templates` cache (id, name, language, category, status, rejection_reason, header/body/footer/buttons/variables, usage_class transactional/campaign/service).
- `spoki_contact_state(contact id, phone, chat_uid, status, is_blocked, has_invalid_phone)`; suppressions for unsubscribed / 131050 / 1044 / repeated 131026.
- Columns: `orders.spoki_last_status`, `orders.spoki_last_event_at`, `contacts.spoki_contact_id`, `contacts.last_spoki_campaign_at`.
- Triggers on conversations: propagate status to campaign recipients (forward-only), recompute COD delivery score (`spoki_engagement` factor: 85 if replied else `max(10, 60 − 10·outbound)`, weight 6), marketing capture (stats, error suppression, unsubscribe phrases), button-reply → auto-reply job.
- Button actions table (template or global, button text → action `show_size|handoff|not_interested|review_link|none`) and auto-reply job queue with rules: global switch, test-only, max click age, active suppression, human active in 48 h, same action in 24 h, daily cap. Handoff opens a Spoki ticket and notifies staff; not_interested suppresses 90 days.

## UI

- WhatsApp button on order / queue: resolve chat link (cache → contact id → phone lookup → URL template fallback), open in a new tab, copy a prefill text.
- Status badge (sent / delivered / read / replied / failed) on queue rows and orders.
- Template dialog: approved templates, favourites first, variable inputs (blocked while missing), preview replacing `%%K%%` / `{{K}}`, send linked to the order.
- Conversation timeline on order and customer: merge by order, contact id, phone; 24 h window from the last inbound (outside it only templates); attachments via public storage → `send_media`; media proxied.
- Dashboard widgets: unresolved webhook errors, health summary (24 h). Dead-letter page with replay. Settings: chat URL template, webhook URL with secret placeholder, contact sync/backfill.
- Marketing (out of scope for the add-on's first version): campaigns with approval, throttle, A/B, holdout, sequences, credit preflight, auto-pause; template studio.

## Client-specific (do not port)

Italian texts, Europe/Rome windows, `39` phone default, GLS/Elogy hold flow and Italian button parsing, size-based actions, Trustpilot link, personal pages, LM custom fields, hard-coded project URLs and test phone in migrations.

## Where docs and code disagreed

`get_messages` documented but absent; reconcile relies on `lastmessage_set` that the API does not return; several crons only altered, never created in the repo; free-form payload documented as `type:"Text"` but code uses `type:"Message"` + `content_type`; phone normalisation differs between webhook and proxy.
