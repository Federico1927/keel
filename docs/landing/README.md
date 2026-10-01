# Keel landing page (`apps/landing`)

Static marketing site for the product, built with Next.js (static export) and Tailwind in the same
monorepo as the app. English at `/`, Italian at `/it/`, same i18n approach as the product
(next-intl, one JSON file per language, a test that fails when a key is missing in one language).

The screenshots in this folder are the landing itself, captured by `pnpm --filter @keel/landing screenshots`:

| File                               | What                    |
| ---------------------------------- | ----------------------- |
| `en-desktop.png`, `it-desktop.png` | Full page at 1440px     |
| `en-mobile.png`, `it-mobile.png`   | Full page at 390px (2x) |

## Run it locally

```bash
pnpm install
pnpm --filter @keel/landing dev        # http://localhost:3100 with hot reload
```

Production build and preview of the exported site:

```bash
pnpm --filter @keel/landing build      # writes apps/landing/out
pnpm --filter @keel/landing start      # serves out/ on http://localhost:3100
```

Quality gate (also run by `pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the root):

```bash
pnpm --filter @keel/landing lint typecheck test
```

### Environment variables

Copy `apps/landing/.env.example` to `apps/landing/.env.local` (or set them on Vercel). All are
public (`NEXT_PUBLIC_*`) because the site is static and the browser needs them.

| Variable                          | Purpose                                                                                      | Default                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`            | Canonical URL for hreflang, Open Graph and the sitemap. **Set it in production.**            | `http://localhost:3100`                  |
| `NEXT_PUBLIC_DEMO_URL`            | External booking link for every "Book a demo" button (Calendly, Cal.com, HubSpot…).          | empty → `mailto:`                        |
| `NEXT_PUBLIC_CONTACT_EMAIL`       | Address used by the `mailto:` fallbacks.                                                     | `federico@automationslab.it`             |
| `NEXT_PUBLIC_CONTACT_WEBHOOK_URL` | Endpoint that receives the contact form as a JSON `POST`. Must accept cross-origin requests. | empty → the form opens a prefilled email |
| `NEXT_PUBLIC_APP_URL`             | URL of the Keel app, for "Sign in" and the links to the integration guides.                  | `http://localhost:3000`                  |

Contact form payload: `{ name, email, store, orders, message, locale, source: "landing", submittedAt }`.
A hidden honeypot field drops bot submissions client-side.

## Change prices, plans and the founding offer

Everything numeric lives in **one file**: `apps/landing/src/config/pricing.ts`.

- `PLANS`: monthly price, included orders, setup fee (`setupFeeFrom: true` renders "from"), feature
  identifiers, `recommended` flag, `inheritsFrom` (renders "Everything in X, plus:").
- `OVERAGE`: price per block of extra orders.
- `ANNUAL_MONTHS_CHARGED`: 10 means two months free on annual billing.
- `ADDONS`: monthly price (with `from`), usage-based or on quote.
- `FOUNDING_OFFER`: `enabled`, `discountPercent`, `months`, `seats`. Set `enabled: false` to remove
  every mention of the offer. The discount applies to monthly billing; the annual toggle shows list
  prices with the two free months.
- `STACK_COMPARISON`: the "what a specialised stack costs" figures and the revenue band.

The words (plan names, taglines, feature labels, FAQ answers) live in `apps/landing/messages/en.json`
and `it.json` under `pricing.*`, `addons.*` and `faq.*`. Feature identifiers in `pricing.ts` map to
`pricing.features.<id>`; adding a feature means one line in the config and one key per language
(the test `messages.test.ts` fails if a language is missing it).

Unit tests for the pricing helpers: `apps/landing/src/config/pricing.test.ts`.

## Change the copy or add a language

- Copy: `apps/landing/messages/<locale>.json`. No visible string is hardcoded in components.
- New language: add `messages/<locale>.json`, add the code to `LANDING_LOCALES` in
  `src/config/site.ts`, register it in `src/i18n/messages.ts`, and create a route group
  `src/app/(<locale>)/<locale>/` with the three one-line files you find in `src/app/(it)/it/`
  (layout, page, opengraph-image). Hreflang, sitemap and the language switch pick it up.

## Modules carousel

The modules section is a horizontal carousel (`src/components/modules-carousel.tsx`): scroll-snap
track, tab strip with the module names, previous/next buttons and auto-advance every 6 seconds that
stops on the first interaction. Order and screenshots per module: `MODULES` in
`src/components/modules.tsx`. Interval: `AUTOPLAY_MS` in the carousel component.

## Product screenshots

The landing shows real screens of the demo tenant **Harbor Home** (no add-ons, so nothing
payment-specific appears in the navigation). Only demo data is shown.

To regenerate after a product change:

```bash
# 1. Product running with the demo seed (see the root README), production build on :3000
pnpm --filter @keel/web build && pnpm --filter @keel/web start

# 2. Capture the screens (PNG, 2x, viewport only) into apps/landing/screenshots-src (git-ignored)
pnpm --filter @keel/landing capture:product

# 3. Convert to the WebP sizes the page uses (apps/landing/public/screenshots/<locale>/)
pnpm --filter @keel/landing images
```

Which screens and which sizes: `apps/landing/src/config/screenshots.ts` (names match
`scripts/capture-product.mjs`). Alt texts: `modules.items.*.alt` and `hero.screenshot_alt` in the
message files.

## Deploy on Vercel

1. Import the repository and set **Root Directory** to `apps/landing` (keep "Include source files
   outside of the Root Directory" enabled: the landing imports `@keel/config` from the workspace).
2. Framework preset: **Next.js**. Vercel detects the pnpm workspace from the root lockfile; the
   default build command (`next build`) produces the static export in `out/`.
3. Environment variables: at least `NEXT_PUBLIC_SITE_URL` (the production domain) and, when ready,
   `NEXT_PUBLIC_DEMO_URL`, `NEXT_PUBLIC_CONTACT_WEBHOOK_URL`, `NEXT_PUBLIC_APP_URL`.
4. `apps/landing/vercel.json` sets the `image/png` content type on the generated Open Graph images
   and long cache headers on the screenshots.

Any other static host works too: upload the contents of `apps/landing/out` after `pnpm --filter @keel/landing build`.
The server in `scripts/serve.mjs` mirrors the expected routing (`/it/` → `it/index.html`, `404.html`).

## Placeholders left on purpose

No testimonials, customer logos, customer counts or result metrics are rendered: a commented
placeholder sits in `src/components/final-cta.tsx` for when real, approved ones exist. The page
claims no certification.
