# Deploying a demo

Keel is three processes: PostgreSQL 16 (with `pgcrypto` and `pg_trgm`), the Next.js web app, and the pg-boss worker. For a client-facing demo in mock mode you need the first two; the worker is optional (webhooks and resyncs run inline after the response when `KEEL_JOBS_QUEUE` is unset, and the queue pages sync on load).

Pick Railway when you want one project with everything inside. Pick Vercel for the web app only when you already live there; the database and the worker still need a host that runs long-lived processes.

## Option A: Railway (recommended for the demo)

The repository carries the Railway configuration: `railway.json` (web) and `railway.worker.json` (worker). Build, start, pre-deploy and healthcheck come from those files; only the variables are set in the dashboard.

1. **Create a project** in the **EU West** region and add a **PostgreSQL** service.
2. **Add a service from this GitHub repo** (root directory: repository root). It picks up `railway.json`:
   - build `pnpm install --frozen-lockfile --prod=false && pnpm build`, start `pnpm --filter @keel/web start` (listens on `$PORT`);
   - pre-deploy `pnpm db:deploy`: creates or updates the `keel_admin` / `keel_app` roles and the `keel` database, runs the migrations, and loads the demo data only when `KEEL_SEED_ON_DEPLOY=1`;
   - healthcheck `GET /api/health`.
3. **Variables** (table below). Reference the Postgres service for the superuser URL, e.g. `DATABASE_SUPERUSER_URL=${{Postgres.DATABASE_URL}}`, and build the two Keel URLs on its private host (`postgres.railway.internal`). Set `KEEL_SEED_ON_DEPLOY=1` for the first deploy, then delete it: every deploy with it rewrites the two demo tenants.
4. **Domain**: Settings → Networking → generate a domain (or add yours), set `AUTH_URL` and `NEXT_PUBLIC_APP_URL` to it with `https://`, redeploy.
5. Open `/login` and sign in with the demo credentials from `README.md` (password `KEEL_DEMO_PASSWORD`).
6. **Worker** (required with `KEEL_INTEGRATION_MODE=live`, optional for a mock demo): add a second service from the same repo, Settings → Config-as-code → `railway.worker.json`, same variables, and `KEEL_JOBS_QUEUE=1` on **both** services. In live mode web and worker refuse to start without it.

### Variables

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_SUPERUSER_URL` | Railway Postgres URL (user `postgres`) | Used by `db:bootstrap` on every deploy |
| `KEEL_ADMIN_PASSWORD`, `KEEL_APP_PASSWORD` | strong random strings | Set before `db:bootstrap`; the next two URLs must use them |
| `DATABASE_ADMIN_URL` | `postgres://keel_admin:<KEEL_ADMIN_PASSWORD>@<host>:5432/keel` | Migrations, seed, console, billing |
| `DATABASE_URL` | `postgres://keel_app:<KEEL_APP_PASSWORD>@<host>:5432/keel` | Requests (RLS) |
| `KEEL_DATABASES` | `keel` | Skip the test database on a hosted instance |
| `AUTH_SECRET` | `openssl rand -base64 32` | |
| `AUTH_URL`, `NEXT_PUBLIC_APP_URL` | `https://<your domain>` | |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` | Credentials at rest; changing it invalidates stored integration credentials |
| `KEEL_INTEGRATION_MODE` | `mock` | Keep `mock` for a demo: no call ever leaves the process. `live` makes the startup checks strict (worker queue, real secrets) |
| `KEEL_DEMO_PASSWORD` | optional | Password of the seeded demo users; default `keel-demo-2026` |
| `KEEL_JOBS_QUEUE` | `1` only with the worker service | |
| `KEEL_SEED_ON_DEPLOY` | `1` for the first deploy only | Loads (and on later deploys rewrites) the demo tenants |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | the project DSN from sentry.io | Optional; errors only, no personal data. The public one is read at build time |
| `SENTRY_ENVIRONMENT` | e.g. `demo`, `production` | Optional |
| `STRIPE_SECRET_KEY`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | empty for the demo | |

If the Railway Postgres URL requires TLS, append `?sslmode=require` to the three database URLs.

## Option B: Vercel for the web app

- Import the repository in Vercel, framework Next.js, **root directory `apps/web`**, install command `corepack enable && pnpm install --frozen-lockfile` (run from the repo root: enable "Include files outside the root directory"), build command `pnpm build` (Turborepo builds the dependencies first).
- Database: Neon, Supabase or the Railway Postgres from option A. Run `pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed` once from your machine against it (`DATABASE_SUPERUSER_URL` = the provider's superuser URL; on Neon/Supabase the default user can create roles).
- Same variables as above in the Vercel project. Leave `KEEL_JOBS_QUEUE` unset unless you also run the worker on Railway against the same database.
- Serverless caveats: webhook processing runs inline inside the request (`after()`), which is fine for a demo and for low volume; schedules (nightly reconcile, billing run, COD tick) need the worker.

## Before showing it to a client

- Reseed right before the demo (`pnpm db:seed` is idempotent for users and rewrites demo billing rows); the dashboards are "today" based, so the data always looks current.
- Change `KEEL_DEMO_PASSWORD` and share only the accounts you want them to use (owner of Northwind or Harbor Home; keep the super-admin for yourself).
- Say up front what is simulated: Integrations show a mock store; "Test connection" and "Resync" exercise the simulator. `docs/EVALUATION.md` §3 lists everything that is mock.
- Health check for the platform: `GET /api/health` returns `{ ok: true }` when the database answers.
