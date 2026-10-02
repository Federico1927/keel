# Deploying a demo

Hullwise is three processes: PostgreSQL 16 (with `pgcrypto` and `pg_trgm`), the Next.js web app, and the pg-boss worker. For a client-facing demo in mock mode you need the first two; the worker is optional (webhooks and resyncs run inline after the response when `HULLWISE_JOBS_QUEUE` is unset, and the queue pages sync on load).

Pick Railway when you want one project with everything inside. Pick Vercel for the web app only when you already live there; the database and the worker still need a host that runs long-lived processes.

## Option A: Railway (recommended for the demo)

Railway no longer reads `railway.json` for new services (Config as Code is deprecated and stops being read on 2026-12-01; its replacement, `.railway/railway.ts`, is applied with the Railway CLI). The settings below go in each service's **Settings** in the dashboard.

1. **Create a project** (EU West for real tenants) and add a **PostgreSQL** service.
2. **Add a service from this GitHub repo**, branch `main`, root directory empty (the monorepo needs the whole tree). Settings:
   - Build command: `pnpm install --frozen-lockfile --prod=false && pnpm build` (the reinstall keeps dev dependencies whatever `NODE_ENV` the builder sets).
   - Start command: `pnpm --filter @hullwise/web start` (listens on `$PORT`).
   - Pre-deploy command: `pnpm db:deploy`, timeout 900 s. It creates or updates the `hullwise_admin` / `hullwise_app` roles and the `hullwise` database, runs the migrations, loads the demo data only when `HULLWISE_SEED_ON_DEPLOY=1`, and always runs `pnpm db:seed:settings`: it creates the configuration rows the demo tenants are missing (return portal and policy, tracking, survey, COD tags, the AI key's mock connection, return costs) without touching orders or any row someone edited, so a feature merged after the last full seed shows up on the next deploy.
   - Healthcheck path `/api/health`, timeout 120 s; restart on failure.
   - Watch paths: `/**` (a narrower pattern such as `/apps/web/**` skips changes in `packages/`).
3. **Variables** (table below). Reference the Postgres service: `DATABASE_SUPERUSER_URL=${{Postgres.DATABASE_URL}}`, and build the two Hullwise URLs on its private host, e.g. `postgres://hullwise_app:${{HULLWISE_APP_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/hullwise`. Set `HULLWISE_SEED_ON_DEPLOY=1` for the first deploy, then delete it: every deploy with it rewrites the two demo tenants.
4. **Domains**: Settings → Networking → add the three custom domains of the web service (`my.hullwise.app`, `admin.hullwise.app`, `api.hullwise.app`, see "Domains" below) and create the CNAME records Railway shows. Set `APP_URL`, `ADMIN_URL`, `API_URL`, `AUTH_URL`, `NEXT_PUBLIC_APP_URL` and `COOKIE_DOMAIN` (table below). For a quick demo a single generated Railway domain is enough: set `APP_URL`, `AUTH_URL` and `NEXT_PUBLIC_APP_URL` to it and leave `ADMIN_URL`, `API_URL` and `COOKIE_DOMAIN` empty (console at `/admin`, API at `/api`).
5. Open `/login` and sign in with the demo users from `README.md` (password `HULLWISE_DEMO_PASSWORD`). After each deploy, `pnpm smoke https://<your domain>` checks the health endpoint, the login page and both demo return portals (exit code 1 on any failure; add paths with `SMOKE_PATHS`).
6. **Worker** (required with `HULLWISE_INTEGRATION_MODE=live`, optional for a mock demo): a second service from the same repo, build `pnpm install --frozen-lockfile --prod=false`, start `pnpm --filter @hullwise/jobs start`, restart always, same variables, and `HULLWISE_JOBS_QUEUE=1` on **both** services. In live mode web and worker refuse to start without it.

### Landing page (`apps/landing`)

A static site (Next.js export) served by its own small Node server; a third service in the same project, from the same repo and branch:

- Build command: `pnpm install --frozen-lockfile --prod=false && pnpm --filter @hullwise/landing build`
- Start command: `pnpm --filter @hullwise/landing start` (serves `apps/landing/out` on `$PORT`); healthcheck `/`.
- Variables, read at build time: `NEXT_PUBLIC_SITE_URL` (its own domain, `https://hullwise.app`), `NEXT_PUBLIC_APP_URL` (the app's domain, `https://my.hullwise.app`), `NEXT_PUBLIC_CONTACT_EMAIL`, optionally `NEXT_PUBLIC_DEMO_URL` (booking link; without it "Book a demo" opens an email) and `NEXT_PUBLIC_CONTACT_WEBHOOK_URL`. Changing one needs a redeploy.

### Variables

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_SUPERUSER_URL` | Railway Postgres URL (user `postgres`) | Used by `db:bootstrap` on every deploy |
| `HULLWISE_ADMIN_PASSWORD`, `HULLWISE_APP_PASSWORD` | strong random strings | Set before `db:bootstrap`; the next two URLs must use them |
| `DATABASE_ADMIN_URL` | `postgres://hullwise_admin:<HULLWISE_ADMIN_PASSWORD>@<host>:5432/hullwise` | Migrations, seed, console, billing |
| `DATABASE_URL` | `postgres://hullwise_app:<HULLWISE_APP_PASSWORD>@<host>:5432/hullwise` | Requests (RLS) |
| `HULLWISE_DATABASES` | `hullwise` | Skip the test database on a hosted instance |
| `AUTH_SECRET` | `openssl rand -base64 32` | |
| `APP_URL` | `https://my.hullwise.app` | Tenant app; every absolute link (emails, notifications, portals) starts here |
| `ADMIN_URL` | `https://admin.hullwise.app` | Super-admin console at the root of this host; also still served at `APP_URL/admin` |
| `API_URL` | `https://api.hullwise.app` | Webhooks, OAuth callbacks, pixel and MCP (`https://api.hullwise.app/mcp`); `/x` on this host is served by `/api/x` |
| `COOKIE_DOMAIN` | `.hullwise.app` | Required with `ADMIN_URL` / `API_URL`: one session for the three hosts, and the OAuth state cookie reaches the callbacks on the API host |
| `AUTH_URL`, `NEXT_PUBLIC_APP_URL` | same as `APP_URL` | `NEXT_PUBLIC_APP_URL` is read at build time: redeploy after changing it |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` | Credentials at rest. Never just replace it: rotate it with `APP_ENCRYPTION_KEY_PREVIOUS` and `pnpm db:rotate-key` (see **Rotating secrets**) |
| `APP_ENCRYPTION_KEY_PREVIOUS` | empty | Only during a key rotation: the old key, so what it encrypted still opens until `pnpm db:rotate-key` has re-encrypted it |
| `HULLWISE_DOCS_URL` | empty | Where the console's "Onboarding runbook" link points; default: `docs/` of the repository on GitHub (`main`) |
| `HULLWISE_INTEGRATION_MODE` | `mock` | Keep `mock` for a demo: no call ever leaves the process. `live` makes the startup checks strict (worker queue, real secrets) |
| `HULLWISE_DEMO_PASSWORD` | optional | Password of the seeded demo users; default `hullwise-demo-2026` |
| `HULLWISE_JOBS_QUEUE` | `1` only with the worker service | |
| `HULLWISE_SEED_ON_DEPLOY` | `1` for the first deploy only | Loads (and on later deploys rewrites) the demo tenants |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | the project DSN from sentry.io | Optional; errors only, no personal data. The public one is read at build time |
| `SENTRY_ENVIRONMENT` | e.g. `demo`, `production` | Optional |
| `STRIPE_SECRET_KEY` | empty for the demo | |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | empty unless the platform has its own public Shopify app | Client ID and secret of the platform app (Advanced → "Install the platform app"). Merchants' own Dev Dashboard apps need no variable: their credentials are stored per tenant, encrypted with `APP_ENCRYPTION_KEY` |
| `HULLWISE_GOOGLE_ADS_CLIENT_ID`, `HULLWISE_GOOGLE_ADS_CLIENT_SECRET`, `HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN` | empty for the demo | The platform's Google Ads app behind "Sign in with Google" (see **Production** below). Without them the card says the sign-in is not available yet and the advanced path (the store's own credentials) still works |
| `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | empty for the demo | The platform's approved TikTok for Business app behind "Connect TikTok" (see **Production**) |
| `HULLWISE_GA4_SERVICE_ACCOUNT_KEY`, `HULLWISE_GA4_SERVICE_ACCOUNT_EMAIL` | empty for the demo | The platform's read-only GA4 service account (see **Production**) |

If the Railway Postgres URL requires TLS, append `?sslmode=require` to the three database URLs.

## Domains

| Host | What | Service | Variable |
| --- | --- | --- | --- |
| `https://hullwise.app` | Landing | landing | `NEXT_PUBLIC_SITE_URL` |
| `https://my.hullwise.app` | Tenant app | web | `APP_URL` (+ `AUTH_URL`, `NEXT_PUBLIC_APP_URL`) |
| `https://admin.hullwise.app` | Super-admin console | web (same service) | `ADMIN_URL` |
| `https://api.hullwise.app` | Webhooks, OAuth callbacks, pixel, MCP | web (same service) | `API_URL` |

No domain is hardcoded: the web app builds every absolute URL from these variables (`packages/config/src/urls.ts`), and the middleware (`apps/web/src/server/host-routing.ts`) routes by host. On the admin host `/tenants` is served by `/admin/tenants`, sign-in pages stay where they are, and tenant pages (`/t/…`) redirect to the app host. On the API host `/mcp`, `/webhooks/shopify`, `/px/<key>` are served by `/api/mcp`, `/api/webhooks/shopify`, `/api/px/<key>`; `/api/…` and `/.well-known/…` keep working. Without `ADMIN_URL` / `API_URL` (local development) nothing is rewritten.

### External URLs to update by hand

These live in third-party dashboards; nothing in the repository can change them. Update them whenever a domain changes.

| Where | Setting | Value |
| --- | --- | --- |
| Shopify Dev Dashboard → each app (the platform public app, and every merchant's own app) → version | App URL | `https://my.hullwise.app` |
| | Allowed redirection URL(s) | `https://api.hullwise.app/integrations/shopify/oauth/callback` (only for "Install on your store" and the platform app; the client credentials path needs none) |
| | Compliance (privacy) webhooks: `customers/data_request`, `customers/redact`, `shop/redact` | `https://api.hullwise.app/webhooks/shopify/compliance` |
| Each connected store | Order, product, inventory, fulfillment, return, customer webhooks | Registered by Hullwise itself when a store is connected (any path: own app, OAuth, legacy token), to `https://api.hullwise.app/webhooks/shopify`. A resync does not re-register them: after a domain change, **reconnect Shopify on every tenant** (Integrations → Shopify) so the subscriptions point at the new URL; deliveries to the old host fail and Shopify eventually removes those subscriptions |
| Meta (developers.facebook.com) | OAuth redirect | None today: Meta connects with a system-user token pasted in Integrations, there is no OAuth redirect to update. If "Continue with Facebook" is added later, the redirect will be `https://api.hullwise.app/integrations/meta/oauth/callback` |
| Google Cloud console → APIs & Services → Credentials → the platform's OAuth client (Web application) | Authorized redirect URI and JavaScript origin | Redirect `https://api.hullwise.app/integrations/google/oauth/callback` ("Sign in with Google" for Google Ads, #90), origin `https://my.hullwise.app`. Stores using the advanced path (their own developer token and refresh token) need nothing here |
| TikTok for Business → your app | Redirect URL | `https://api.hullwise.app/integrations/tiktok/oauth/callback` |
| Stripe dashboard → Developers → Webhooks | Endpoint URL | `https://api.hullwise.app/webhooks/stripe` (the signing secret stays in `STRIPE_WEBHOOK_SECRET`) |
| WhatsApp / messaging provider of the COD add-on | Delivery webhook | Per tenant: copy it again from **COD → Settings** (it starts with `https://api.hullwise.app/webhooks/cod-messaging/…`) |
| Resend → Webhooks | Endpoint URL | `https://api.hullwise.app/webhooks/email` (signing secret in `RESEND_WEBHOOK_SECRET`) |
| Resend → Domains | Sending domain | Verify the sender domain (e.g. `mail.hullwise.app`) with the SPF, DKIM and DMARC records Resend shows, then set `EMAIL_FROM` to `Hullwise <no-reply@mail.hullwise.app>` |
| MCP clients (Claude, ChatGPT, Cursor…) | Server URL | `https://api.hullwise.app/mcp`. Clients connected to an old URL must remove and re-add the connector: tokens are bound to the resource URL they were issued for |
| Merchants' storefronts | First-party pixel script | `https://api.hullwise.app/px/<key>/script.js` and the Shopify custom-pixel code shown in **Integrations → Pixel and conversions**; stores that installed an older snippet must paste the new one |
| Post-purchase survey | Link in Shopify's order confirmation email | Copy it again from **Analytics → Survey** (it starts with `https://my.hullwise.app/s/…`) |

## Production

### Platform owner account (before the first real store)

The demo super-admin (`superadmin@hullwise.demo`) signs in with the public demo password, and the reseed resets it on every deploy. It must never see real tenants. On the web service set:

- `HULLWISE_OWNER_EMAIL`: your own address (not a `.demo` one).
- `HULLWISE_OWNER_PASSWORD`: at least 12 characters. Used only to create the account on the next deploy (`db:seed:settings`); later deploys never change it. Change it from your profile after the first sign-in, then delete the variable.

From that deploy on, the demo super-admins stop being super-admins (the log says `demo super-admins removed from the console`), and they stay so: the reseed never re-promotes them. The demo tenants keep their demo users. Create real tenants from your owner account and open them with "Open as support" until the store's own users can receive their invitation email (`RESEND_API_KEY`).

### Vendor prerequisites

What the platform owner registers on the vendors' side before real stores connect by themselves (#90). Every card in **Integrations** carries the merchant's own step-by-step checklist; this list is only the owner's part. Nothing here is needed for the demo (`HULLWISE_INTEGRATION_MODE=mock`): the simulator answers every card, including the errors (each card lists its demo values). Vendor consoles change often: treat each step as "to verify" on the day you do it.

| Integration | Merchant path (in the card) | Owner prerequisite | Variables |
| --- | --- | --- | --- |
| Shopify | Own Dev Dashboard app, Client ID + secret (#89) | None for the main path. Optional: a public Shopify app (Partner dashboard, App Store review) for "Install the platform app" | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (optional) |
| Meta Ads + Conversions API | System user in their Business Manager, never-expiring token with `ads_read`, `ads_management`, `business_management`, ad account id(s) and pixel id pasted | None for the pilot path: the token is the merchant's, made with an app of their own business. Later path "Continue with Facebook" (not built): a Hullwise Meta app (type Business), App Review for `ads_read` / `ads_management` / `business_management` with Advanced Access, Business Verification of the Hullwise company, then the redirect in the table above | none today |
| Google Ads (+ Enhanced Conversions) | "Sign in with Google", pick the account (manager accounts expanded) | 1. A Google Ads manager account (MCC) for Hullwise → Admin → API Center → apply for a developer token with **Basic access** (the token starts as test-only: production accounts answer "developer token pending" until approved). 2. A Google Cloud project with the Google Ads API enabled. 3. OAuth consent screen (External, app name, support e-mail, privacy policy and terms URLs on the landing site, authorized domain `hullwise.app`) with the scope `https://www.googleapis.com/auth/adwords`; this scope is **sensitive**: submit the app for verification (demo video of the sign-in and the use of the data) before going past 100 test users. 4. An OAuth client of type Web application with the redirect URI and origin in the table above | `HULLWISE_GOOGLE_ADS_CLIENT_ID`, `HULLWISE_GOOGLE_ADS_CLIENT_SECRET`, `HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN` |
| TikTok Ads | "Connect TikTok", pick the advertiser accounts | A TikTok for Business developer app (business-api.tiktok.com → My apps) with the permission groups Ad Account Management, Ads Management, Reporting (Creative Management for thumbnails), the advertiser redirect URL `https://api.hullwise.app/integrations/tiktok/oauth/callback`, submitted and **approved** by TikTok | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` |
| Google Analytics 4 | Add our reader e-mail as Viewer on their property, paste the property ID (#86) | A Google Cloud service account (no roles needed) with a JSON key, the Google Analytics Data API and Admin API enabled in its project | `HULLWISE_GA4_SERVICE_ACCOUNT_KEY` (JSON or base64), `HULLWISE_GA4_SERVICE_ACCOUNT_EMAIL` (optional) |
| AI assistant (Anthropic) | Their own API key from console.anthropic.com | None: each store pays Anthropic directly | none |
| Address validation (Google) | Their own Google Maps Platform key with Address Validation API and Places API (New) | None: each store pays Google directly | none |
| WhatsApp (Spoki), `addon.whatsapp_spoki` | Their Spoki API key; our per-tenant webhook URL pasted in Spoki | None (the add-on is switched on per tenant in the console). The webhook URL is built from `API_URL` and `APP_ENCRYPTION_KEY`: changing either means every Spoki store pastes it again (after a key rotation the old URL keeps working while `APP_ENCRYPTION_KEY_PREVIOUS` is set) | none |
| Recharge / Loop, `addon.subscriptions` | Their API token and webhook signing secret; our per-tenant webhook URL pasted in the app | None | none |
| Shopify Subscriptions, `addon.subscriptions` | Contract scopes added to their Shopify app version, then Connect | Contracts created by the Shopify Subscriptions app belong to that app: ask Shopify (Partner support) for access to subscription contracts of other apps for the stores' apps or the platform app; without it the connection works and finds no contracts | none |
| Accounting, audiences, email tools | No live provider yet | Nothing to register | none |

Before switching a deployment to `HULLWISE_INTEGRATION_MODE=live`, open each card as a tenant owner: an OAuth path whose variables are missing says so on the card ("not available yet") instead of failing at the vendor.

### Rotating secrets

Rotate a secret when it may have leaked (a laptop lost, a variable pasted in a chat, someone with Railway access leaving), not on a calendar. Each one below says what breaks and how to do it. Change variables on **both** services (web and worker) in the same staged change, then deploy once.

#### `AUTH_SECRET`

Signs the session cookies (Auth.js JWT) and a few short-lived or long-lived links. There is no fallback to an old value: after the deploy

- everybody is signed out and signs in again (sessions are cookies signed with it); one-time sign-in grants (60 s) and return-portal sessions (60 min) in flight stop working;
- **return label links** already emailed to customers (`/r/<store>/label/<id>?sig=…`) stop opening: a customer who still needs one asks the store;
- the IP hashes of the password-reset rate limit restart from zero (harmless);
- **MCP tokens** (personal access tokens, OAuth access and refresh tokens) are stored as HMAC with a pepper that, when `MCP_TOKEN_PEPPER` is not set, is derived from `AUTH_SECRET`: rotating it disconnects every MCP client. To keep them, first set `MCP_TOKEN_PEPPER` to `hullwise-mcp-token-pepper:` followed by the **old** `AUTH_SECRET` (exactly the derived value), then rotate `AUTH_SECRET`. If the leak concerns the database too, let the tokens go instead: people reconnect their clients.

Procedure: `openssl rand -base64 32` → new `AUTH_SECRET` on web and worker (plus `MCP_TOKEN_PEPPER` as above if wanted) → deploy.

#### `APP_ENCRYPTION_KEY`

AES-256-GCM key of every stored secret, and HMAC key of a few derived values. Replacing it outright makes every stored credential unreadable (every live integration falls into error). Rotate it in three steps instead:

1. **Window open.** Set `APP_ENCRYPTION_KEY_PREVIOUS` to the current key and `APP_ENCRYPTION_KEY` to a new one (`openssl rand -base64 32`), on web and worker, and deploy. From now on everything new is encrypted with the new key, and whatever the old key encrypted still opens (decryption tries the new key, then the previous one). The startup log warns `APP_ENCRYPTION_KEY_PREVIOUS is set` until the window is closed.
2. **Re-encrypt.** From a Railway shell of the web service (or from a machine with the same variables: both keys and `DATABASE_ADMIN_URL`), run `pnpm db:rotate-key --dry-run`, read the report, then `pnpm db:rotate-key`. It re-encrypts, row by row, every payload only the old key opens; it is idempotent (run it again: `0 re-encrypted`), never overwrites a value changed meanwhile (a renewed Shopify token wins), and writes an audit entry (`platform.encryption_key_rotated`). What it covers:

   | Stored where | What |
   | --- | --- |
   | `integrations.credentials_encrypted` | Every integration's credentials (Shopify, Meta, Google, TikTok, GA4, Anthropic, address validation, Slack, Spoki, Recharge/Loop…) |
   | `integrations.config → app.secretEncrypted` | The client secret of a merchant's own Shopify app ("Install on your store") |
   | `integrations.config → pendingSignIn.tokenEncrypted` | A Google sign-in waiting for the account pick (30 min) |
   | `ad_accounts.credentials_encrypted` | Extra Meta ad accounts with their own token |
   | `return_requests.bank_details_enc` | IBAN and holder for refunds by transfer |
   | `webhook_endpoints.secret_enc`, `previous_secret_enc` | Signing secrets of the tenants' outgoing webhooks |
   | `pgboss.job` (`email.send`, not finished) | Queued emails, encrypted until delivered |

   It also re-hashes the platform email suppression list (below). Exit code 1 and `UNREADABLE` in the report mean a payload opens with neither key: do not go on before explaining it (usually a row written with a third, older key; `--dry-run` again after fixing).
3. **Window closed.** Run `pnpm db:rotate-key` once more **without** `APP_ENCRYPTION_KEY_PREVIOUS` (remove it from your shell, keep it on the services): it only verifies and must end with `Every stored payload opens with the current key.` Then delete `APP_ENCRYPTION_KEY_PREVIOUS` from web and worker and deploy. Keep the old key in your password manager for a few weeks: backups taken before the rotation need it.

Values **derived** from the key (HMAC) cannot be re-encrypted, because the input is not stored. What changes, and what keeps working during the window:

| Derived value | Effect of the new key | Old value during the window | After the window |
| --- | --- | --- | --- |
| Spoki webhook URL (`/webhooks/spoki/<tenant>/<token>`, add-on WhatsApp) | New token: **WhatsApp → Settings** shows the new URL | Accepted | Rejected (404): every Spoki store must paste the new URL **before** the window closes |
| COD messaging webhook URL (`/webhooks/cod-messaging/<tenant>/<token>`, add-on COD) | Same: **COD → Settings** shows the new URL | Accepted | Rejected: paste the new URL in the messaging provider before closing |
| Unsubscribe links in emails already sent | New links in new emails | Accepted | Rejected ("invalid link"): the recipient uses the link of a newer email, or the store adds the suppression by hand (**Notifications → Suppressions**) |
| OAuth `state` of a connection in progress (10 min) | — | Accepted | Rejected: start the connection again |
| Email address hashes: platform suppression list (`email_address_suppressions`), delivery log (`email_messages.recipient_hash`, `email_events`), password-reset rate limit | New hashes for new rows | Lookups match both keys: a bounced address stays blocked | `db:rotate-key` added a new-key row for every suppressed address the database still knows (users, invitations, customers, tenant suppression lists). Suppressions of addresses it does not know (the report counts them) and older log rows stop matching: the console's recipient search no longer finds pre-rotation emails, and such an address could be emailed once more until it bounces again |

Not affected: survey links (per-store secret, stored in clear), outgoing-webhook signatures (the endpoint's own secret, re-encrypted above), Shopify/Stripe/Resend webhook signatures (the vendors' secrets).

#### Database role passwords (`HULLWISE_ADMIN_PASSWORD`, `HULLWISE_APP_PASSWORD`)

`pnpm db:bootstrap` (first step of the pre-deploy `pnpm db:deploy`) runs `ALTER ROLE … PASSWORD` for `hullwise_admin` and `hullwise_app` with these variables on **every** deploy, through `DATABASE_SUPERUSER_URL`. So a rotation is one staged change:

1. Generate the new password(s). In the same change set, on **web and worker**: `HULLWISE_APP_PASSWORD` and the password inside `DATABASE_URL`; `HULLWISE_ADMIN_PASSWORD` and the password inside `DATABASE_ADMIN_URL` (rotate one role at a time if you want a smaller blast radius). Only the web service runs the pre-deploy, but the worker must get the new URLs in the same deploy.
2. Deploy. The pre-deploy sets the new passwords; the new web and worker releases connect with them. Connections the old release already holds stay open until it stops (Postgres checks the password only when connecting); new connections of the old release fail for the minute of the switch, so pick a quiet moment.
3. Check `/api/health`, then the worker log (`[jobs] worker started`, no `password authentication failed`).

The Postgres superuser (`DATABASE_SUPERUSER_URL`, Railway's own `postgres` user) is managed by Railway: regenerate it from the Postgres service (Variables / credentials; to verify in the current dashboard), then make sure `DATABASE_SUPERUSER_URL` still references `${{Postgres.DATABASE_URL}}` so the next pre-deploy can connect.

#### `HULLWISE_DEMO_PASSWORD`

Password of the seeded demo users (never of real users or of the platform owner). It is applied only by the full seed (`pnpm db:seed`, or a deploy with `HULLWISE_SEED_ON_DEPLOY=1`), which also rewrites the two demo tenants' data. Change the variable on the web service, deploy with `HULLWISE_SEED_ON_DEPLOY=1` once (the pre-deploy takes about 4 minutes longer), then delete `HULLWISE_SEED_ON_DEPLOY`. Demo sessions already open stay signed in until they expire.

### Backups and restore

**What exists.** Railway's Postgres service keeps its data on a volume; backups of that volume are configured on the Postgres service (**Backups** tab: manual backup now, plus daily / weekly / monthly schedules, each with its own retention; plan-dependent, to verify in the current dashboard). A Railway restore puts a backup back **onto the same service** (it replaces the current data after you confirm and deploy the staged change), so it is the tool for "we lost the database", not for reading one old row. Turn on at least the daily schedule before the first real store, and take a manual backup before every risky operation (key rotation, migration with data changes, tenant deletion).

**Logical dumps** (portable, readable anywhere, the way to rehearse a restore). The admin role owns the schema and bypasses RLS, so it dumps every tenant. From a machine with PostgreSQL 16 client tools, through the Postgres service's public TCP proxy (Settings → Networking; the private host only answers inside the project):

```bash
export SRC="postgres://hullwise_admin:$HULLWISE_ADMIN_PASSWORD@<proxy-host>:<proxy-port>/hullwise?sslmode=require"
pg_dump --format=custom --no-owner --file="hullwise-$(date +%F).dump" "$SRC"
pg_restore --list "hullwise-$(date +%F).dump" | head      # readable, schemas public, drizzle, pgboss
```

The dump contains personal data and encrypted credentials: store it encrypted, where only the platform owner can read it, and delete it when the backup retention says so (it also holds customers that were erased afterwards, see **Privacy requests**). It is useless without the `APP_ENCRYPTION_KEY` of the day it was taken: keep the two together.

**Restore test on a copy** (do it once before the first real store, then every few months). Locally (Docker or a system PostgreSQL 16, see the README):

```bash
# 1. roles, database, extensions and default grants (local superuser)
HULLWISE_DATABASES=hullwise_restore pnpm db:bootstrap
# 2. the data, as the admin role; ownership and grants come from step 1 and 3, not from the dump
pg_restore --no-owner --no-privileges --exit-on-error \
  -d postgres://hullwise_admin:hullwise_admin@127.0.0.1:5432/hullwise_restore "hullwise-<date>.dump"
# 3. grants on the restored tables to the application role
HULLWISE_DATABASES=hullwise_restore pnpm db:bootstrap
# 4. schema up to date: applies nothing for a dump of the current release, the newer migrations otherwise
DATABASE_ADMIN_URL=postgres://hullwise_admin:hullwise_admin@127.0.0.1:5432/hullwise_restore pnpm db:migrate
```

Then check, with `psql` on the restored database:

1. **Migrations**: `select count(*) from drizzle.__drizzle_migrations;` equals the number of `.sql` files in `packages/db/migrations` of the release you will run.
2. **Roles, grants and RLS**: `select has_table_privilege('hullwise_app', 'public.orders', 'SELECT');` is `t`; `select count(*) from pg_policies where 'hullwise_app' = any(roles);` is not 0; connected as `hullwise_app`, `select count(*) from orders;` returns **0** (no tenant set), and `begin; select set_config('app.tenant_id', '<tenant id>', true); select count(*) from orders; commit;` returns that tenant's orders only.
3. **Data**: `select t.slug, count(o.id) from tenants t left join orders o on o.tenant_id = t.id group by 1 order by 1;` matches the production numbers of the dump's day.
4. **Secrets**: with the production `APP_ENCRYPTION_KEY` in the environment and `DATABASE_ADMIN_URL` pointing at the copy, `pnpm db:rotate-key --dry-run` ends with `Every stored payload opens with the current key.`
5. **App**: point a local `.env` at the copy (mock mode: `HULLWISE_INTEGRATION_MODE=mock`, no vendor is called), `pnpm dev`, sign in as the platform owner, open a real tenant with "Open as support".

Drop the copy afterwards (`dropdb hullwise_restore`).

**Real restore** into a new Railway Postgres service (when the old one is unusable): create the service, set `DATABASE_SUPERUSER_URL` to its URL and `HULLWISE_DATABASES=hullwise`, run steps 1 to 4 from a Railway shell or through its proxy, point `DATABASE_URL` and `DATABASE_ADMIN_URL` (web and worker) at the new host, deploy. After any restore: jobs queued at dump time run again (handlers are idempotent); Shopify webhooks received after the dump are lost, so open **Integrations** on each live tenant and run **Resync** on Shopify (the nightly reconciliation would catch up too); invoices and payments after the dump must be checked against Stripe.

### Privacy requests (GDPR) and tenant deletion

The merchant is the controller of its customers' data, Hullwise the processor; the platform owner answers the merchant. What works today:

| Request | How it reaches us | What happens | Where to check |
| --- | --- | --- | --- |
| A customer's data (access) | Shopify `customers/data_request` at `API_URL/webhooks/shopify/compliance`, or the merchant asks | Logged, audited (`integration.compliance.customers.data_request`) and turned into a console task (**Alerts**, kind `compliance_request`) with the Hullwise customer id; no per-customer export exists yet (see gaps): open the customer in the tenant (**Customers → the customer**: profile, orders, returns) and, for a full copy, take the tenant export and keep the rows with that `customer_id` / its orders' ids | `/admin/alerts`; the tenant's **Audit log** |
| Erase a customer | Shopify `customers/redact` (sent by Shopify 10 days after the merchant's erasure request) | **Automatic** since go-live (#88): the customer and the orders listed by Shopify (`orders_to_redact`, guest orders included) keep ids, amounts, dates, statuses, country and lines, and lose name, email, phone, addresses, order note and attributes, IBAN and customer note on returns, custom portal answers, free-text survey answers, raw webhook payloads, Meta/Google conversion payloads, storefront-pixel links and checkout IPs, WhatsApp/COD message recipients and bodies, COD risk profiles. One audit entry `customer.redacted` with counts, no personal data; no console task | The tenant's **Audit log**; the customer page shows an anonymous customer |
| The store leaves (erase the shop) | Shopify `shop/redact` (48 h after uninstall), or the merchant asks | The Shopify connection is cleared at once (no credentials kept) and a console task asks for the tenant's deletion within 30 days | `/admin/alerts` |
| A full copy of the store's data | The owner, or the platform owner for them | **Data export**: every tenant table, one CSV each, in a zip, read inside the tenant's RLS transaction; secrets, tokens and binary files excluded; background job `tenant.export`; kept 7 days; audited | Owner: **Settings → Data export** (`/t/<store>/settings/data-export`); console: the tenant's page, **Data export** card |

Kept on purpose after a customer erasure: the store's suppression entries for that address (an opt-out must keep being honoured), staff notes and timeline diffs written by the team, audit entries, and backups until their retention expires. If the merchant asks for those too, edit them by hand.

**Deleting a tenant** (no console button yet). Every tenant table references `tenants` with `ON DELETE CASCADE`, so one statement removes everything; rehearse it on a restored copy first.

1. If the merchant wants their data, run the **Data export** and send it.
2. Cancel the subscription (console tenant page, **Subscription and invoices**; in Stripe too when billing is live) and move the tenant to **churned** (lifecycle control): its users are locked out. The console dashboard lists churned tenants past the 90-day retention.
3. Take a manual backup (above).
4. As `hullwise_admin`:

   ```sql
   begin;
   select id, slug, name, status from tenants where id = '<tenant id>';   -- the right one, churned
   insert into audit_logs (tenant_id, actor_type, action, entity_type, entity_id, metadata)
     values (null, 'super_admin', 'tenant.deleted', 'tenant', '<tenant id>', '{"slug": "<slug>", "reason": "<shop/redact or request>"}');
   delete from tenants where id = '<tenant id>';
   commit;
   ```

5. Users who belonged only to that tenant keep an account without workspaces: disable or delete them in **Console → Users** if the request covers them. Resolve the console task. Backups keep the tenant until their retention expires.

### Shared demo + live deployment

Today one Railway project serves the public demo (Northwind Apparel, Harbor Home, the console's sample tenants) and real stores, on one database, with `HULLWISE_INTEGRATION_MODE=live`.

What is safe:

- **A reseed rewrites only demo rows.** `seedDomain` deletes and regenerates data `where tenant_id = <demo tenant>` for the two demo tenants only; `seedPlatform` upserts the demo users (by `.demo` email), the demo tenants and the five sample console tenants by slug, their invoices, add-ons and integration rows; platform rows it writes are its own (job runs and email log rows marked as seed, its alerts by signature). `db:seed:settings`, run on every deploy, only fills missing configuration rows of the two demo tenants and the platform owner. No query of the seed touches a tenant it did not create.
- **Demo tenants stay simulated in live mode**: their integration rows are `mode = mock`, so the adapters used for them are the simulators, even with `HULLWISE_INTEGRATION_MODE=live`.
- **Demo emails never reach the real email provider**: addresses on reserved or demo domains (`.demo`, `example.com`, `.test`, `.example`, `.invalid`) are marked `suppressed` (`reserved_domain`) in the delivery log instead of being sent, so demo clicks do not bounce on Resend.
- **The demo super-admin is not a super-admin** once `HULLWISE_OWNER_EMAIL` is set (above), and the reseed does not promote it again.

The risks that remain:

- Demo users sign in with a **public password** on the same database as real stores: tenant isolation (RLS on every tenant table, isolation tests) is the only wall between them and real data. A bug in a query that bypasses RLS (admin connection) would be reachable from a public account.
- Slugs and emails are shared namespaces: the demo and sample slugs (`northwind-apparel`, `harbor-home`, `alpine-outdoor`, `coral-beauty`, `delta-gear`, `maple-kids`, `fjord-home`) and the `.demo` users exist already, so a real tenant cannot take them; if one of those rows were deleted by hand, the next reseed would recreate it, and a real tenant created with that slug in between would be overwritten.
- `HULLWISE_SEED_ON_DEPLOY=1` left set reseeds on every deploy: minutes of heavy writes on the database real stores use (and the demo resets). Keep it unset and reseed on purpose.
- The worker runs the demo tenants' schedules too (simulated syncs, digests, campaigns): CPU and database load that real stores pay for.
- One set of secrets, one backup, one restore for both: restoring the database for a real store also rewinds the demo, and the other way round; a leak of the demo's environment is a leak of production.

Splitting later (when the first stores pay, or before showing the demo widely):

1. Create a second Railway project (or environment) **demo**: Postgres, web, worker, same repository and branch, `HULLWISE_INTEGRATION_MODE=mock`, its own secrets (new `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, role passwords), `HULLWISE_SEED_ON_DEPLOY=1` for its first deploy, its own domain (e.g. `demo.hullwise.app`), no `RESEND_API_KEY`, no Stripe live keys, no vendor apps.
2. Point every public demo link (README, landing copy, sales emails) at the demo project's domain.
3. In production, remove the demo: take a backup, then delete the demo and sample tenants with the tenant deletion statement above (one per slug) and the `.demo` users (`delete from users where email like '%.demo' and is_super_admin = false;`, after checking the list), and keep `HULLWISE_SEED_ON_DEPLOY` unset.
4. From then on production never runs the seed: `db:deploy` still runs `db:seed:settings`, which does nothing without demo tenants.

## Rename cutover

The product was renamed on 2026-10-02 (see `docs/DECISIONS.md`): environment variables, database roles, packages and cookies changed name. A deployment configured with the old names must be converted once, in this order, ideally in a quiet hour (the app is unreachable for a minute or two while the roles are renamed and the new release starts):

1. In the Railway variables of **every** service (web, worker): rename each variable that starts with `KEEL_` to the same name starting with `HULLWISE_` (e.g. `KEEL_ADMIN_PASSWORD` → `HULLWISE_ADMIN_PASSWORD`, `KEEL_APP_PASSWORD`, `KEEL_DATABASES`, `KEEL_DEMO_PASSWORD`, `KEEL_INTEGRATION_MODE`, `KEEL_JOBS_QUEUE`, `KEEL_SEED_ON_DEPLOY`, `KEEL_MCP_DISABLED`, `KEEL_RETENTION_DAYS`, `KEEL_EMAIL_OUTBOX_DIR`), keeping the values. Web, worker and `db:bootstrap` refuse to start while an old-prefix variable is still set, and say which one to rename.
   In the service settings, the build and start commands that filter by package name change too: `--filter @keel/web` → `--filter @hullwise/web`, `--filter @keel/landing` → `--filter @hullwise/landing`. Stage these with the variables and apply them in the same deploy: the old commands match no package once the new code is on `main`.
2. In `DATABASE_URL` and `DATABASE_ADMIN_URL`, change only the user names: `keel_app` → `hullwise_app`, `keel_admin` → `hullwise_admin`. Keep passwords, host and database name as they are.
3. Deploy. The pre-deploy `pnpm db:bootstrap` renames the roles in place (`ALTER ROLE … RENAME`: grants, ownership and row-level-security policies follow the role, passwords are set again from `HULLWISE_*_PASSWORD`), then `pnpm db:migrate` converts the stored values that used the old name (migration `0039`). This was rehearsed on a copy with 21,140 orders: roles renamed, 640 discounts converted, RLS still scoped to one tenant.
4. The database keeps its current name. Renaming it (`ALTER DATABASE … RENAME TO hullwise`) is optional, needs every connection closed, and then `HULLWISE_DATABASES` and both URLs must change too; there is no functional reason to do it.
5. Add the new domains (above), set `APP_URL`, `ADMIN_URL`, `API_URL`, `COOKIE_DOMAIN`, `AUTH_URL`, `NEXT_PUBLIC_APP_URL`, redeploy, then update the external URLs in the table above.
6. Expect: users sign in again on the new hosts (sessions are per host until `COOKIE_DOMAIN` is set), the theme preference cookie resets once (renamed), MCP clients reconnect, merchants re-paste the pixel snippet (its first-party cookies were renamed, so returning visitors count as new once). Shopify exchange orders created before the cutover carry the old note-attribute name and are not linked automatically to their return; there are none outside the demo.
7. When every environment is converted, delete `packages/config/src/legacy.ts` and its two uses (runtime check, bootstrap).

## Option B: Vercel for the web app

- Import the repository in Vercel, framework Next.js, **root directory `apps/web`**, install command `corepack enable && pnpm install --frozen-lockfile` (run from the repo root: enable "Include files outside the root directory"), build command `pnpm build` (Turborepo builds the dependencies first).
- Database: Neon, Supabase or the Railway Postgres from option A. Run `pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed` once from your machine against it (`DATABASE_SUPERUSER_URL` = the provider's superuser URL; on Neon/Supabase the default user can create roles).
- Same variables as above in the Vercel project. Leave `HULLWISE_JOBS_QUEUE` unset unless you also run the worker on Railway against the same database.
- Serverless caveats: webhook processing runs inline inside the request (`after()`), which is fine for a demo and for low volume; schedules (nightly reconcile, billing run, COD tick) need the worker.

## Before showing it to a client

- Reseed right before the demo (`pnpm db:seed` is idempotent for users and rewrites demo billing rows); the dashboards are "today" based, so the data always looks current.
- Change `HULLWISE_DEMO_PASSWORD` and share only the accounts you want them to use (owner of Northwind or Harbor Home; keep the super-admin for yourself).
- Say up front what is simulated: Integrations show a mock store; "Test connection" and "Resync" exercise the simulator. `docs/EVALUATION.md` §3 lists everything that is mock.
- Health check for the platform: `GET /api/health` returns `{ ok: true }` when the database answers.
