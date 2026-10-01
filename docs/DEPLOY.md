# Deploying a demo

Keel is three processes: PostgreSQL 16 (with `pgcrypto` and `pg_trgm`), the Next.js web app, and the pg-boss worker. For a client-facing demo in mock mode you need the first two; the worker is optional (webhooks and resyncs run inline after the response when `KEEL_JOBS_QUEUE` is unset, and the queue pages sync on load).

Pick Railway when you want one project with everything inside. Pick Vercel for the web app only when you already live there; the database and the worker still need a host that runs long-lived processes.

## Option A: Railway (recommended for the demo)

1. **Create a project** and add a **PostgreSQL** service. Copy its connection string (`DATABASE_URL` in the Postgres service variables; the user is `postgres`, a superuser).
2. **Add a service from this GitHub repo** for the web app.
   - Root directory: repository root (the monorepo needs the whole tree).
   - Build command: `corepack enable && pnpm install --frozen-lockfile && pnpm build`
   - Start command: `pnpm --filter @keel/web start`
   - Variables (see the table below). Use the Postgres service's private URL (`postgres.railway.internal`) where available.
3. **Prepare the database once**, from the web service's shell or a one-off deploy command:
   ```bash
   pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed
   ```
   `db:bootstrap` creates the `keel_admin` and `keel_app` roles with the passwords you set in `KEEL_ADMIN_PASSWORD` / `KEEL_APP_PASSWORD` and the `keel` database (set `KEEL_DATABASES=keel` so no test database is created). Later deploys only need `pnpm db:migrate` (put it in the service's pre-deploy / release command).
4. **Optional worker service** from the same repo: same build command, start command `pnpm --filter @keel/jobs start`, same variables plus `KEEL_JOBS_QUEUE=1` on both services.
5. **Domain**: add the Railway domain (or your own) and set `AUTH_URL` and `NEXT_PUBLIC_APP_URL` to it, with `https://`. Redeploy.
6. Open `/login`, sign in with the demo credentials from `README.md`.

### Variables

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_SUPERUSER_URL` | Railway Postgres URL (user `postgres`) | Only needed by `db:bootstrap` |
| `KEEL_ADMIN_PASSWORD`, `KEEL_APP_PASSWORD` | strong random strings | Set before `db:bootstrap`; the next two URLs must use them |
| `DATABASE_ADMIN_URL` | `postgres://keel_admin:<KEEL_ADMIN_PASSWORD>@<host>:5432/keel` | Migrations, seed, console, billing |
| `DATABASE_URL` | `postgres://keel_app:<KEEL_APP_PASSWORD>@<host>:5432/keel` | Requests (RLS) |
| `KEEL_DATABASES` | `keel` | Skip the test database on a hosted instance |
| `AUTH_SECRET` | `openssl rand -base64 32` | |
| `AUTH_URL`, `NEXT_PUBLIC_APP_URL` | `https://<your domain>` | |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` | Credentials at rest; changing it invalidates stored integration credentials |
| `KEEL_INTEGRATION_MODE` | `mock` | Keep `mock` for a demo: no call ever leaves the process |
| `KEEL_DEMO_PASSWORD` | optional | Password of the seeded demo users; default `keel-demo-2026` |
| `KEEL_JOBS_QUEUE` | `1` only with the worker service | |
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
