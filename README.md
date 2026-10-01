# Keel

Multi-tenant, multilingual operations platform for mid-sized e-commerce stores that sell on Shopify and advertise on Meta and Google. The product name lives in one constant (`PRODUCT_NAME` in `packages/config`).

The core serves any store with any payment method. Cash on delivery is an add-on (`addon.cod`), never a core assumption.

## One-command start

```bash
cp .env.example .env
docker compose up -d --wait && pnpm install && pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed && pnpm dev
```

Then open <http://localhost:3000>. The web app runs on port 3000 and the job runner starts next to it.

`db:bootstrap` is idempotent: it creates the `keel_admin` / `keel_app` roles and the `keel` / `keel_test` databases if the Docker init script has not already done so, using the compose superuser (`postgres` / `postgres`).

### If `pnpm db:migrate` says `role "keel_admin" does not exist`

Something other than the Keel container answered on port 5432, or the container was still initialising. Check:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN          # should list only com.docker (or docker-proxy)
docker compose logs postgres | grep -i keel_admin
```

A local PostgreSQL (Postgres.app, Homebrew) listening on 5432 wins over the container for `127.0.0.1` connections. Either stop it, or move Keel to another port: change `5432:5432` to `5433:5432` in `docker-compose.yml` and replace `:5432` with `:5433` in the four `*_URL` lines of `.env`, then rerun the command above from `docker compose up`.

Without Docker (cloud sandboxes, CI): install PostgreSQL 16 as a system package, start it, run `pnpm db:bootstrap` once to create the `keel_admin` / `keel_app` roles and the `keel` / `keel_test` databases, then continue from `pnpm db:migrate`. Schema, migrations and RLS policies are identical; only `DATABASE_URL` changes.

The seed is deterministic and takes about 40 seconds: two tenants, 21,000 orders, 180 products, 42 campaigns, 12 months of history.

## Demo credentials

Password for every demo user: `keel-demo-2026`.

| Email | Role | Tenant |
| --- | --- | --- |
| `superadmin@keel.demo` | Platform super-admin | `/admin` console, can open any tenant as support |
| `owner@northwind.demo` | owner | Northwind Apparel (IT, EUR, Italian, `addon.cod` active) |
| `admin@northwind.demo` | admin | Northwind Apparel |
| `ops@northwind.demo` | operations | Northwind Apparel |
| `care@northwind.demo`, `care2@northwind.demo` | customer_care | Northwind Apparel |
| `marketing@northwind.demo` | marketing | Northwind Apparel |
| `viewer@northwind.demo` | viewer | Northwind Apparel |
| `owner@harborhome.demo` | owner | Harbor Home (US, USD, English, no add-ons) |
| `ops@harborhome.demo` | operations | Harbor Home |
| `marketing@harborhome.demo` | marketing | Harbor Home |
| `multi@keel.demo` | admin + viewer | Both tenants (tenant switcher) |

Tenant URLs: `/t/northwind-apparel` and `/t/harbor-home`. Magic links are printed to the server console in development.

## Repository structure

```
apps/web                 Next.js 15 app: tenant workspace (/t/<slug>), super-admin console (/admin), webhooks, OAuth
packages/config          Product name, locales, roles and permission matrix, module registry, plans, defaults
packages/core            Pure domain logic: canonical statuses, state rules, economics, segments, returns, billing math
packages/db              Drizzle schema (56 tables), migrations, RLS, withTenant, deterministic seed, isolation tests
packages/integrations    Adapter interfaces + Shopify / Meta / Google live adapters + mock simulators + credential crypto
packages/services        Use cases on top of db + core, shared by web and jobs (orders, sync, analytics, billing, ...)
packages/jobs            pg-boss worker: webhook processing, syncs, reconciliation, billing and add-on ticks
packages/addon-cod       Cash-on-delivery add-on: confirmation queue, operator assignment, delivery score, recipient risk
packages/ui              Shared Tailwind + shadcn-style components
docs/                    ARCHITECTURE, DECISIONS, PROGRESS, EVALUATION (Italian), reference study, screenshots
```

## Everyday commands

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # the gate every phase passed
pnpm test:e2e                                            # Playwright against the production build on :3000
pnpm --filter @keel/web screenshots                      # regenerate docs/screenshots (en + it)
pnpm db:generate                                         # new migration after a schema change
pnpm db:reset                                            # drop, migrate, seed
```

Integration tests run against a real PostgreSQL (`keel_test`), including one isolation test per tenant table proving tenant A can neither read nor write tenant B.

## Modes

- `KEEL_INTEGRATION_MODE=mock` (default): every adapter is an in-memory simulator seeded with the demo data; no network call ever leaves the process. Webhooks and failures (rate limit, expired token) can be simulated from the Integrations page.
- `KEEL_INTEGRATION_MODE=live`: tenants whose integration row is in `live` mode with stored credentials use the real Shopify Admin GraphQL, Meta Marketing and Google Ads APIs.
- `STRIPE_SECRET_KEY` empty: `MockBillingProvider`. Set to a test key: `StripeBillingProvider`.
- `KEEL_JOBS_QUEUE=1`: web enqueues work through pg-boss for the worker; unset, it processes inline after the response.

Hosting a demo on Railway or Vercel: `docs/DEPLOY.md`.

See `docs/ARCHITECTURE.md` for the design and `docs/EVALUATION.md` (Italian) for what is real, what is mock and what is missing.
