# Add-on: WhatsApp via Spoki (`addon.whatsapp_spoki`)

Status: **v1 in development** (`packages/config/src/addon-versions.ts`). The super-admin console shows it but cannot switch it on for a new store until v1 is released. On the demo it is already on for Northwind Apparel (the seed and the deploy-time settings step turn it on).

Issue: #9. The add-on is an approved exception to CLAUDE.md §12 (no specific messaging provider in the core). Only `packages/addon-spoki` knows about Spoki. The core and the COD add-on never import it.

## What it does

The store connects its own Spoki account (an API key and a webhook URL to paste in Spoki). Then:

- **Templates per event.** Each event that sends a message gets an approved WhatsApp template from the account: order confirmed, order shipped and order delivered, the campaign message (with `addon.customer_campaigns`), and each COD confirmation template (with `addon.cod`). Custom fields map to the product's variables. An event without a template is sent as free text, which WhatsApp only accepts within 24 hours of the customer's last message.
- **Order notifications.** Every 5 minutes the `whatsapp` tick sends a notification when an order moves forward to confirmed, shipped or delivered, but only for the events the store switched on. Each order and event is notified at most once (idempotency key `order:<id>:<event>`). Status changes from before activation are never messaged.
- **COD confirmation by WhatsApp** (with `addon.cod`). The confirmation template is sent from the order's COD card or the queue. The customer's reply is matched against the store's keywords. A confirm keyword ("sì", "ok"…) records a confirmed outcome, written to the store first, exactly like an operator's. A cancel keyword ("no", "annulla"…) escalates the order to a person and never cancels it on its own. Any other reply goes on the timeline. The COD logic stays in `packages/addon-cod`: Spoki hands it the reply through a hook.
- **WhatsApp campaigns** (with `addon.customer_campaigns`). WhatsApp campaigns and their test sends go through Spoki and use the template mapped to "campaign". They pass through the same send queue, throttle and suppression list as the other channels.
- **Conversations.** The message log is grouped by customer. The "Awaiting reply" filter shows the threads where the customer wrote last, except opt-outs and COD keyword replies, which were already handled automatically. A thread shows every message with its delivery status and the order it is linked to, plus whether the 24-hour window is open. The team can answer in free text while the window is open. The answer is linked to the conversation's order, appears on its timeline and is audited.
- **Inbound webhook.** Delivery receipts move a message's status forward only: sent → delivered → read → replied, or failed. Customer messages are logged and linked to the order of the last message sent to that number (campaign messages never link an order). Webhook events are stored once (idempotent on message id + status), processed after the response, and retried by the tick.
- **Opt-outs.** A reply equal to an opt-out keyword ("STOP"…) adds the number to the shared suppression list, and so does the provider's "user stopped marketing" error (131050). WhatsApp and SMS campaigns then skip that customer.
- **Message log** on the order page, the customer page and the settings page. The MCP tool `get_whatsapp_messages` reads it.

Permissions: the WhatsApp pages (Conversations, Settings) are for owners and admins (`whatsapp_settings`). The connection needs `manage_integrations`. Every role that can open an order sees that order's WhatsApp log. A store without the add-on gets a 404 on every page, action, webhook route, job and MCP tool.

## Try it on the demo

Password for every demo user: `hullwise-demo-2026` (or `HULLWISE_DEMO_PASSWORD` on a hosted demo).

1. **Connection and settings.** Sign in as `owner@northwind.demo`, then open **WhatsApp settings** in the sidebar.
   - On the Spoki card: **Test connection** answers with the simulated account. **Manage** shows the webhook URL to paste in Spoki (with **Copy**), the health sources, **Resync** (reads the account's 6 templates) and **Disconnect**.
   - Below: the last 7 days in numbers, then the template of each event (COD "Conferma ordine" → `cod_confirmation`, shipping and delivery switched on), the opt-out keywords, the COD reply keywords ("sì, si, confermo, ok" / "no, annulla, annullare"), and the latest messages (campaign sends are left out of that list: they are in Conversations).
2. **Conversations.** Open the **Conversations** tab.
   - Click **Awaiting reply**. The customer asking to have the parcel delivered to their office ("Via Roma 10, Milano") wrote less than two hours before the demo was seeded or deployed. Open the thread: the badge says free-text replies are allowed until a given time. Write an answer and click **Send reply**. It appears on the right as "Team reply" and the thread leaves the filter.
   - Open an older thread, for example a campaign recipient. The window is closed, so the reply box explains that only templates can be sent. In the dashed box, type what the customer would write and click **Simulate customer message**. The message comes in through the real webhook route, the window opens, and the reply box appears.
   - Other threads show the history: a size exchange and a tracking question answered by customer care (Luca Romano), replies to the WhatsApp campaign, a "STOP" opt-out, and a COD customer asking when the courier arrives.
3. **COD confirmation by WhatsApp reply.** Open **COD queue** (owner, or `care@northwind.demo`) and open an order nobody has messaged yet.
   - On the COD card, the "Conferma ordine" template is selected: click **Send**. In **WhatsApp messages** at the bottom of the order, the message appears as "COD confirmation" with the `cod_confirmation` template, status "Sent".
   - On that message, open **Simulate**. **Read receipt** moves it to "Read". **Customer replies “sì”** (the store's first confirm keyword, whatever the viewer's language) posts the reply to the webhook. After a moment the reply is in the log, the COD card shows the order "Confirmed" with a WhatsApp attempt, and the timeline has "WhatsApp reply received". **Customer replies “no”** escalates the order to an admin instead.
4. **Order notifications.** Open any shipped order from the last 30 days that has a phone number. Its log has the "Order shipped" message (and "Order delivered" once delivered), and the timeline has "WhatsApp message sent". Use **Simulate → Failed receipt** to see a provider error.
5. **WhatsApp campaign.** See [customer-campaigns.md](customer-campaigns.md): the "Saldi di fine estate su WhatsApp -20%" campaign was sent through Spoki. Its messages are in the log with receipts and a few replies.
6. **Gating.** Sign in as `ops@northwind.demo`: no WhatsApp pages (404), but order pages show the log. Sign in as `owner@harborhome.demo` (no add-on): no nav entry, no Spoki card, and `/t/harbor-home/whatsapp` is a 404.
7. **Console.** Sign in as `superadmin@hullwise.demo`, open the Northwind tenant, then Add-ons. The add-on shows "v1 in development" with its summary. It cannot be switched on for another tenant until it is released.

The tour is automated in `apps/web/e2e/addon-spoki-tour.spec.ts` (desktop and iPhone 15).

## Mock vs live-ready

| Part | Mock (demo, `HULLWISE_INTEGRATION_MODE=mock`) | Live-ready |
| --- | --- | --- |
| Adapter | `MockSpokiChannel` (per process): accepts any valid number, rejects unapproved templates, deterministic ids | `SpokiChannel`: API v1, `X-Spoki-Api-Key`, template and free-text sends, templates with pagination, contacts, lists, tickets. Tested on recorded fixtures only |
| Connection | Any key connects the simulated account. The setup panel's demo values answer with each mapped error | API key encrypted at rest (AES-GCM), tested on save |
| Receipts and replies | Simulate menu on each message and "Simulate customer message" in a thread. Both post to the tenant's own webhook URL, so the route, token, idempotency and processing run exactly as with Spoki | Spoki posts to `/api/webhooks/spoki/<tenant>/<token>`. The payload format is from Spoki's documentation, marked "To verify" |
| Order notifications, COD replies, campaigns, conversations | Same code path. Only the adapter differs | Same |
| Demo data | Seed: about 1,500 messages over 30 days (campaign, COD, shipping and delivery notices), threads with team replies, one waiting thread, one opt-out. Delivered to a deployed demo by `ensureDemoSettings` (insert-only, once) | — |

## Release checklist (before v1 can be released)

- [ ] Connect a real Spoki account (staging number) and run the guide end to end. Confirm the "To verify" steps: where the API key is, where the webhook goes, and the webhook payload fields (message uuid, `send_status` values, inbound text and quoted message id).
- [ ] Send each mapped template live: COD confirmation, order notices, campaign. Check that custom fields reach the template and that the approved language matches `templateLanguage`.
- [ ] Verify receipts and replies from Spoki against the recorded fixtures: out-of-order statuses, the error codes 131026 (not on WhatsApp) and 131050 (stopped marketing), and credit exhaustion (`spoki::1029`).
- [ ] Confirm that free text outside the 24-hour window is refused by Spoki the way the product expects. The product already refuses it before sending.
- [ ] Decide who may read and answer conversations. Today only owners and admins can (`whatsapp_settings`); customer care sees the log only on order pages. A dedicated page key for conversations, with write access for customer care, is the likely change.
- [ ] Decide whether a customer message that is not a keyword should notify someone (today it only shows in "Awaiting reply" and on the order timeline).
- [ ] Load: throttle WhatsApp campaign sends to the account's messaging tier (`campaignThrottlePerMinute.whatsapp`, default 60/min).
- [ ] Privacy: check that `customers/redact` covers `spoki_messages` (it does in code: recipients and bodies) and the Spoki contact on the provider side (not done: Spoki keeps its own copy).
- [ ] Flip `addon.whatsapp_spoki` v1 to `released` in `addon-versions.ts`. Billing (49 USD/month, `MODULES` in `packages/config`) then starts for active tenants.

Not in v1 (optional, from #9): Spoki flows and automations, creating templates from the product, media and interactive buttons, automatic answers and handover to an operator, a contact table linking to the Spoki chat.
