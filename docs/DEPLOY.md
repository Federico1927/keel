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
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` | Credentials at rest; changing it invalidates stored integration credentials |
| `HULLWISE_INTEGRATION_MODE` | `mock` | Keep `mock` for a demo: no call ever leaves the process. `live` makes the startup checks strict (worker queue, real secrets) |
| `HULLWISE_DEMO_PASSWORD` | optional | Password of the seeded demo users; default `hullwise-demo-2026` |
| `HULLWISE_JOBS_QUEUE` | `1` only with the worker service | |
| `HULLWISE_SEED_ON_DEPLOY` | `1` for the first deploy only | Loads (and on later deploys rewrites) the demo tenants |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | the project DSN from sentry.io | Optional; errors only, no personal data. The public one is read at build time |
| `SENTRY_ENVIRONMENT` | e.g. `demo`, `production` | Optional |
| `STRIPE_SECRET_KEY`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | empty for the demo | |

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
| Shopify Partner dashboard → your app → Configuration | App URL | `https://my.hullwise.app` |
| | Allowed redirection URL(s) | `https://api.hullwise.app/integrations/shopify/oauth/callback` |
| | Compliance / app webhooks (if configured in the dashboard) | `https://api.hullwise.app/webhooks/shopify` |
| Each connected store | Order, product, inventory, fulfillment, return, customer webhooks | Registered by Hullwise itself when a store is connected with a custom-app token, to `https://api.hullwise.app/webhooks/shopify`. A resync does not re-register them: after a domain change, **reconnect Shopify on every tenant** (Integrations → Shopify) so the subscriptions point at the new URL; deliveries to the old host fail and Shopify eventually removes those subscriptions |
| Meta (developers.facebook.com) | OAuth redirect | None today: Meta connects with a system-user token pasted in Integrations, there is no OAuth redirect to update. If Facebook Login is added later, the redirect will be `https://api.hullwise.app/integrations/meta/oauth/callback` |
| Google Cloud console / Google Ads | OAuth redirect and authorized origins | None today: Google Ads connects with a developer token and refresh token pasted in Integrations. If an OAuth flow is added later: redirect `https://api.hullwise.app/integrations/google/oauth/callback`, authorized origin `https://my.hullwise.app` |
| TikTok for Business → your app | Redirect URL | `https://api.hullwise.app/integrations/tiktok/oauth/callback` |
| Stripe dashboard → Developers → Webhooks | Endpoint URL | `https://api.hullwise.app/webhooks/stripe` (the signing secret stays in `STRIPE_WEBHOOK_SECRET`) |
| WhatsApp / messaging provider of the COD add-on | Delivery webhook | Per tenant: copy it again from **COD → Settings** (it starts with `https://api.hullwise.app/webhooks/cod-messaging/…`) |
| Resend → Webhooks | Endpoint URL | `https://api.hullwise.app/webhooks/email` (signing secret in `RESEND_WEBHOOK_SECRET`) |
| Resend → Domains | Sending domain | Verify the sender domain (e.g. `mail.hullwise.app`) with the SPF, DKIM and DMARC records Resend shows, then set `EMAIL_FROM` to `Hullwise <no-reply@mail.hullwise.app>` |
| MCP clients (Claude, ChatGPT, Cursor…) | Server URL | `https://api.hullwise.app/mcp`. Clients connected to an old URL must remove and re-add the connector: tokens are bound to the resource URL they were issued for |
| Merchants' storefronts | First-party pixel script | `https://api.hullwise.app/px/<key>/script.js` and the Shopify custom-pixel code shown in **Integrations → Pixel and conversions**; stores that installed an older snippet must paste the new one |
| Post-purchase survey | Link in Shopify's order confirmation email | Copy it again from **Analytics → Survey** (it starts with `https://my.hullwise.app/s/…`) |

## Rename cutover

The product was renamed on 2026-10-02 (see `docs/DECISIONS.md`): environment variables, database roles, packages and cookies changed name. A deployment configured with the old names must be converted once, in this order, ideally in a quiet hour (the app is unreachable for a minute or two while the roles are renamed and the new release starts):

1. In the Railway variables of **every** service (web, worker): rename each variable that starts with `HULLWISE_` to the same name starting with `HULLWISE_` (e.g. `HULLWISE_ADMIN_PASSWORD` → `HULLWISE_ADMIN_PASSWORD`, `HULLWISE_APP_PASSWORD`, `HULLWISE_DATABASES`, `HULLWISE_DEMO_PASSWORD`, `HULLWISE_INTEGRATION_MODE`, `HULLWISE_JOBS_QUEUE`, `HULLWISE_SEED_ON_DEPLOY`, `HULLWISE_MCP_DISABLED`, `HULLWISE_RETENTION_DAYS`, `HULLWISE_EMAIL_OUTBOX_DIR`), keeping the values. Web, worker and `db:bootstrap` refuse to start while an old-prefix variable is still set, and say which one to rename.
2. In `DATABASE_URL` and `DATABASE_ADMIN_URL`, change only the user names: `hullwise_app` → `hullwise_app`, `hullwise_admin` → `hullwise_admin`. Keep passwords, host and database name as they are.
3. Deploy. The pre-deploy `pnpm db:bootstrap` renames the roles in place (`ALTER ROLE … RENAME`: grants, ownership and row-level-security policies follow the role, passwords are set again from `HULLWISE_*_PASSWORD`), then `pnpm db:migrate` converts the stored values that used the old name (migration `0041`). This was rehearsed on a copy with 21,140 orders: roles renamed, 640 discounts converted, RLS still scoped to one tenant.
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
